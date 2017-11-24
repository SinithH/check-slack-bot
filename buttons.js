const config = require('./config.js'),
      request = require('request'),
      util = require('util'),
      aws = require('aws-sdk'),
      VERIFICATION_TOKEN = config.slack.verificationToken,
      ACCESS_TOKEN = config.slack.accessToken;

const { executeMutation, verify, getCheckSlackUser, getRedisClient, formatMessageFromData, t, getGraphqlClient } = require('./helpers.js');

const sendErrorMessage = function(callback, thread, channel, link) {
  callback(null, { response_type: 'ephemeral', replace_original: false, delete_original: false, text: t('Sorry,_seems_that_you_do_not_have_the_permission_to_do_this._Please_go_to_Check_and_login_by_your_Slack_user,_or_continue_directly_from_Check') + ': ' + link });
};

const error = function(data, callback) {
  callback(null, { response_type: 'ephemeral', replace_original: false, delete_original: false, text: t('Sorry,_seems_that_you_do_not_have_the_permission_to_do_this._Please_go_to_Check_and_login_by_your_Slack_user,_or_continue_directly_from_Check') + ': ' + data.original_message.attachments[0].title_link });
};

const changeStatus = function(data, token, callback) {
  const value = JSON.parse(data.callback_id);
  
  const vars = {
    id: value.last_status_id,
    status: data.actions[0].selected_options[0].value,
    clientMutationId: `fromSlackMessage:${data.message_ts}`
  };

  const mutationQuery = `($status: String!, $id: ID!, $clientMutationId: String!) {
    updateStatus: updateStatus(input: { clientMutationId: $clientMutationId, id: $id, status: $status }) {
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

  data.link = data.original_message.attachments[0].title_link;
  data.team_slug = value.team_slug;

  const done = function(resp) {
    const obj = resp.updateStatus.project_media;
    obj.metadata = JSON.parse(obj.metadata);
    const json = { response_type: 'in_channel', replace_original: true, delete_original: false, attachments: formatMessageFromData(obj) };
    callback(null, json);
  };
  
  executeMutation(mutationQuery, vars, sendErrorMessage, done, token, callback, {}, data);
};

const saveToRedisAndReplyToSlack = function(data, token, callback, mode, newMessage, attachments) {
  const value = JSON.parse(data.callback_id);
  const redis = getRedisClient();
  
  redis.on('connect', function() {
    redis.set('slack_message_ts:' + config.redisPrefix + ':' + data.message_ts, JSON.stringify({ mode: mode, object_type: 'project_media', object_id: value.id, link: value.link, team_slug: value.team_slug, graphql_id: value.graphql_id }), function(e) {
      if (e) {
        console.log('Redis error: ' + e);
        error(data, callback);
      }
      else {
        let json = { text: newMessage + ':', thread_ts: data.message_ts, replace_original: false, delete_original: false, response_type: 'in_channel' };
        callback(null, json);

        json = { response_type: 'in_channel', replace_original: true, delete_original: false, attachments: attachments, token: ACCESS_TOKEN };
        
        const options = {
          uri: data.response_url,
          method: 'POST',
          json: json
        };

        request(options, function(err, response, body) {
          console.log('Output from delayed response: ' + body);
        });
    
        console.log('Saved Redis key slack_message_ts:' + data.message_ts);
      }
      redis.quit();
    });
  });
};

const addComment = function(data, token, callback) {
  const newMessage = t('type_your_comment_below');

  let attachments = JSON.parse(JSON.stringify(data.original_message.attachments).replace(/\+/g, ' '));
  attachments[0].actions[1] = {
    name: 'type_comment',
    text: t('type_your_comment_in_the_thread_below'),
    type: 'button',
    style: 'default'
  };
  attachments[0].actions[2] = {
    name: 'edit',
    text: t('edit', true),
    type: 'select',
    options: [
      { text: t('title'), value: 'title' },
      { text: t('description'), value: 'description' }
    ],
    style: 'primary'
  };

  saveToRedisAndReplyToSlack(data, token, callback, 'comment', newMessage, attachments);
};

const editTitle = function(data, token, callback) {
  const newMessage = t('type_the_title_below');

  let attachments = JSON.parse(JSON.stringify(data.original_message.attachments).replace(/\+/g, ' '));
  attachments[0].actions[1] = {
    name: 'add_comment',
    text: t('add_comment', true),
    type: 'button',
    style: 'primary'
  };
  attachments[0].actions[2] = {
    name: 'edit',
    text: t('edit', true),
    type: 'select',
    options: [
      { text: t('type_title_below'), value: 'type_title' },
      { text: t('description'), value: 'description' }
    ],
    selected_options: [
      { text: t('type_title_below'), value: 'type_title' },
    ],
    style: 'primary'
  };
  
  saveToRedisAndReplyToSlack(data, token, callback, 'edit_title', newMessage, attachments);
};

const editDescription = function(data, token, callback) {
  const newMessage = t('type_the_description_below');

  let attachments = JSON.parse(JSON.stringify(data.original_message.attachments).replace(/\+/g, ' '));
  attachments[0].actions[1] = {
    name: 'add_comment',
    text: t('add_comment', true),
    type: 'button',
    style: 'primary'
  };
  attachments[0].actions[2] = {
    name: 'edit',
    text: t('edit', true),
    type: 'select',
    options: [
      { text: t('title'), value: 'title' },
      { text: t('type_description_below'), value: 'type_description' }
    ],
    selected_options: [
      { text: t('type_description_below'), value: 'type_description' },
    ],
    style: 'primary'
  };
  
  saveToRedisAndReplyToSlack(data, token, callback, 'edit_description', newMessage, attachments);
};

const imageSearch = function(data, callback, context) {
  const image = data.original_message.attachments[0].image_url;

  if (image) {

    // Invoke Lambda function to get reverse images in background, because Slack doesn't wait more than 3s

    aws.config.loadFromPath('./aws.json');
    
    const lambda = new aws.Lambda({
      region: config.awsRegion
    });
    
    lambda.invoke({
      FunctionName: config.googleImageSearchFunctionName || 'google-image-search',
      InvocationType: 'Event',
      Payload: JSON.stringify({ image_url: image, response_url: data.response_url, thread_ts: data.message_ts, channel: data.channel })
    }, function(error, resp) {
      if (error) {
        console.log('Error from Google Image Search lambda function: ' + util.inspect(error));
      }
      if (resp) {
        console.log('Response from Google Image Search lambda function: ' + util.inspect(resp));
      }
    });
  
    callback(null, { response_type: 'ephemeral', replace_original: false, delete_original: false, text: t('please_wait_while_I_look_for_similar_images_-_I_will_post_a_reply_inside_a_thread_above') });
  }
  else {
    callback(null, { response_type: 'ephemeral', replace_original: false, delete_original: false, text: t('there_are_no_images_on_this_report') });
  }
};

const process = function(data, callback, context) {
  if (data.token === VERIFICATION_TOKEN) {
    
    getCheckSlackUser(data.user.id,
      function(err) {
        console.log('Error when trying to identify Slack user: ' + util.inspect(err));
        error(data, callback);
      },

      function(token) {
        switch (data.actions[0].name) {
          case 'change_status':
            changeStatus(data, token, callback);
            break;
          case 'add_comment':
            addComment(data, token, callback);
            break;
          case 'type_comment':
            callback(null, { response_type: 'ephemeral', replace_original: false, delete_original: false, text: t('please_type_your_comment_inside_the_thread_above') });
            break;
          case 'edit':
            const attribute = data.actions[0].selected_options[0].value;
            switch (attribute) {
              case 'title':
                editTitle(data, token, callback);
                break;
              case 'description':
                editDescription(data, token, callback);
                break;
              case 'type_title':
                callback(null, { response_type: 'ephemeral', replace_original: false, delete_original: false, text: t('please_type_the_new_title_inside_the_thread_above') });
                break;
              case 'type_description':
                callback(null, { response_type: 'ephemeral', replace_original: false, delete_original: false, text: t('please_type_the_new_description_inside_the_thread_above') });
                break;
            }
            break;
          case 'image_search':
            imageSearch(data, callback, context);
            break;
          default:
            error(data, callback);
        }
      }
    );
  
  }
  
  else {
    error(data, callback);
  }
};

exports.handler = function(data, context, callback) {
  const body = Buffer.from(data.body, 'base64').toString();
  const payload = JSON.parse(decodeURIComponent(body).replace(/^payload=/, ''));
  
  switch (data.type) {
    case 'url_verification':
      verify(data, callback);
      break;
    default:
      process(payload, callback, context);
  }
};
