const config = require('./config.js'),
      https = require('https'),
      request = require('request'),
      qs = require('querystring'),
      util = require('util'),
      ACCESS_TOKEN = config.slack.accessToken;
      
const { executeMutation, verify, getCheckSlackUser, getRedisClient, formatMessageFromData, t, getGraphqlClient } = require('./helpers.js');

const getProjectMedia = function(teamSlug, projectId, projectMediaId, callback, done) {
  const client = getGraphqlClient(teamSlug, config.checkApi.apiKey, callback);

  const projectMediaQuery = `
  query project_media($ids: String!) {
    project_media(ids: $ids) {
      id
      dbid
      metadata
      last_status
      last_status_obj {
        id
      }
      log_count
      created_at
      updated_at
      tasks_count
      project {
        title
      }
      tags {
        edges {
          node {
            tag
          }
        }
      }
      author_role
      user {
        name
        profile_image
        source {
          image
        }
      }
      team {
        name
        slug
      }
      verification_statuses
    }
  }
  `;

  client.query(projectMediaQuery, { ids: projectMediaId + ',' + projectId })
  .then((resp, errors) => {
    if (errors) {
      console.log('GraphQL query error: ' + util.inspect(errors));
    }
    else {
      console.log('GraphQL query response: ' + util.inspect(resp));
      const pm = resp.project_media;
      pm.metadata = JSON.parse(pm.metadata);
      done(pm);
    }
  })
  .catch(function(e) {
    console.log('GraphQL query error: ' + e.toString());
  });
};

const process = function(event, callback) {
  const mainRegexp = new RegExp(config.checkWeb.url, 'g');
  const regexp = new RegExp(config.checkWeb.url + '/([^/]+)/project/([0-9]+)/media/([0-9]+)', 'g');

  // This message contains a Check URL to be parsed

  if (!event.bot_id && mainRegexp.test(event.text)) {
    while (matches = regexp.exec(event.text)) {

      const teamSlug = matches[1],
            projectId = matches[2],
            projectMediaId = matches[3];

      getProjectMedia(teamSlug, projectId, projectMediaId, callback, function(data) {
        const message = {
          token: ACCESS_TOKEN,
          channel: event.channel,
          attachments: JSON.stringify(formatMessageFromData(data))
        };

        const query = qs.stringify(message);
        https.get('https://slack.com/api/chat.postMessage?' + query, (res) => {
          console.log('Slack response status code: ' + res.statusCode);
        }).on('error', (e) => {
          console.log('Slack error: ' + util.inspect(e));
        });
      });
    }
  }

  // This message is a Check report parsed by the bot
  
  if (event.bot_id && event.text === '' && event.attachments && event.attachments.length > 0 && regexp.test(event.attachments[0].fallback)) {
    try {
      storeSlackMessage(event, callback);
    }
    catch (e) {
      // Ignore
    }
  }

  // This message is a reply to a button action

  if (!event.bot_id && event.thread_ts) {
    
    // Look for this thread on Redis to see if it's related to any Check media

    const redis = getRedisClient();
    redis.get('slack_message_ts:' + config.redisPrefix + ':' + event.thread_ts, function(err, reply) {
      
      if (err) {
        console.log('Error when getting information from Redis: ' + err);
      }
      
      else if (!reply) {
        console.log('Could not find Redis key slack_message_ts:' + event.thread_ts);
      }
      
      else {
        const data = JSON.parse(reply.toString());

        // Adding comment or changing title

        if (data.object_type === 'project_media' && (data.mode === 'comment' || data.mode === 'edit_title')) {

          getCheckSlackUser(event.user,
            
            function(err) {
              console.log('Error when trying to identify Slack user: ' + util.inspect(err));
              sendErrorMessage(callback, event.thread_ts, event.channel, data.link);
            },
            
            function(token) {

              // Adding comment

              if (data.mode === 'comment') {
                createComment(event, data, token, callback, function(resp) {
                  const message = { text: t('your_comment_was_added') + ': ' + data.link, thread_ts: event.thread_ts, replace_original: false, delete_original: false,
                                    response_type: 'ephemeral', token: ACCESS_TOKEN, channel: event.channel };
                  const query = qs.stringify(message);
                  https.get('https://slack.com/api/chat.postMessage?' + query);
                });
              }

              // Changing title

              else if (data.mode === 'edit_title') {
                updateTitle(event, data, token, callback, function(resp) {
                  const obj = resp.updateProjectMedia.project_media;
                  obj.metadata = JSON.parse(obj.metadata);
                  
                  let message = { ts: event.thread_ts, channel: event.channel, attachments: formatMessageFromData(obj) };
                  const headers = { 'Authorization': 'Bearer ' + ACCESS_TOKEN, 'Content-type': 'application/json' }; 

                  request.post({ url: 'https://slack.com/api/chat.update', json: true, body: message, headers: headers }, function(err, res, resjson) {
                    if (err) {
                      console.log('Error when trying to update Slack message: ' + err);
                    }
                  });

                  message = { text: t('title_was_changed_to') + ': ' + obj.metadata.title, thread_ts: event.thread_ts, replace_original: false, delete_original: false,
                              response_type: 'ephemeral', token: ACCESS_TOKEN, channel: event.channel };
                  query = qs.stringify(message);
                  https.get('https://slack.com/api/chat.postMessage?' + query);
                });
              }
            }
          );
        }
      }
        
      redis.quit();
    });
  }

  callback(null);
};

const sendErrorMessage = function(callback, thread, channel, link) {
  const message = { text: t('Sorry,_seems_that_you_do_not_have_the_permission_to_do_this._Please_go_to_Check_and_login_by_your_Slack_user,_or_continue_directly_from_Check') + ' ' + link, thread_ts: thread, replace_original: false, delete_original: false,
                    response_type: 'ephemeral', token: ACCESS_TOKEN, channel: channel };
  const query = qs.stringify(message);
  https.get('https://slack.com/api/chat.postMessage?' + query);
};

const createComment = function(event, data, token, callback, done) {
  const pmid = data.object_id.toString(),
        text = event.text;

  const mutationQuery = `($text: String!, $pmid: String!, $clientMutationId: String!) {
    createComment: createComment(input: { clientMutationId: $clientMutationId, text: $text, annotated_id: $pmid, annotated_type: "ProjectMedia" }) {
      project_media {
        dbid
      }
    }
  }`;
  
  executeMutation(mutationQuery, { text: text, pmid: pmid, clientMutationId: `fromSlackMessage:${event.thread_ts}` }, sendErrorMessage, done, token, callback, event, data);
}

const storeSlackMessage = function(event, callback) {
  const json = JSON.parse(event.attachments[0].callback_id);

  const vars = {
    set_fields: JSON.stringify({ slack_message_id: event.ts, slack_message_channel: event.channel, slack_message_attachments: JSON.stringify(event.attachments) }),
    annotated_id: `${json.id}`,
    clientMutationId: `fromSlackMessage:${event.ts}`
  };

  const mutationQuery = `($set_fields: String!, $annotated_id: String!, $clientMutationId: String!) {
    createDynamic: createDynamic(input: { clientMutationId: $clientMutationId, set_fields: $set_fields, annotated_id: $annotated_id, annotated_type: "ProjectMedia", annotation_type: "slack_message" }) {
      project_media {
        dbid
      }
    }
  }`;

  const ignore = function() { /* Do nothing */ };
  
  executeMutation(mutationQuery, vars, ignore, ignore, config.checkApi.apiKey, callback, event, { team_slug: json.team_slug });
}

const updateTitle = function(event, data, token, callback, done) {
  const id = data.graphql_id,
        text = event.text;
  
  const mutationQuery = `($embed: String!, $id: ID!, $clientMutationId: String!) {
    updateProjectMedia: updateProjectMedia(input: { clientMutationId: $clientMutationId, embed: $embed, id: $id }) {
      project_media {
        id
        dbid
        metadata
        last_status
        last_status_obj {
          id
        }
        log_count
        created_at
        updated_at
        tasks_count
        project {
          title
        }
        tags {
          edges {
            node {
              tag
            }
          }
        }
        author_role
        user {
          name
          profile_image
          source {
            image
          }
        }
        team {
          name
          slug
        }
        verification_statuses
      }
    }
  }`;
  
  const vars = {
    embed: JSON.stringify({ title: text }),
    id: id,
    clientMutationId: `fromSlackMessage:${event.thread_ts}`
  };

  executeMutation(mutationQuery, vars, sendErrorMessage, done, token, callback, event, data);
}

exports.handler = function(data, context, callback) {
  switch (data.type) {
    case 'url_verification':
      verify(data, callback);
      break;
    case 'event_callback':
      process(data.event, callback);
      break;
    default:
      callback(null);
  }
};
