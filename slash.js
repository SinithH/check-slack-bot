// This function adds a ProjectMedia to Check and sends a message back to Slack

/*
 * data = {
 *   project_id,
 *   url,
 *   response_url,
 * }
 */

const config = require('./config.js'),
      request = require('request'),
      util = require('util'),
      qs = require('querystring'),
      aws = require('aws-sdk');

const { getCheckSlackUser, t, getTeamConfig, humanAppName } = require('./helpers.js');

const permissionError = function(callback) {
  callback(null, t('Sorry,_seems_that_you_do_not_have_the_permission_to_do_this._Please_go_to_the_app_and_login_by_your_Slack_user,_or_continue_directly_from_there') + ': ' + config.checkWeb.url );
};

const process = function(body, token, callback) {
  const setProjectRegexp = new RegExp(/set <(.+)>/, 'g');
  const showProjectRegexp = new RegExp(/^show/, 'g');
  const addUrlRegexp = new RegExp(/<(.+)>/, 'g');
  const activateBotRegexp = new RegExp(/^bot activate/, 'g');
  const sendBotRegexp = new RegExp(/^bot send (.*)/, 'g');

  let action = '';
  if (projectUrl = setProjectRegexp.exec(body.text)) {
    const projectRegexp = new RegExp(config.checkWeb.url + '/([^/]+)/project/([0-9]+)', 'g');
    if (matches = projectRegexp.exec(projectUrl[1])) {
      text = t('setting_project...');
      action = 'setProject';
    } else { text = t('invalid_project_URL') + ': ' + projectUrl[1]; }
  } else if (matches = showProjectRegexp.exec(body.text)) {
    text = t('getting_project...');
    action = 'showProject';
  } else if (matches = addUrlRegexp.exec(body.text)) {
    text = t('sending_URL_to') + ' ' + humanAppName() + ': ' + matches[1];
    action = 'createProjectMedia';
  } else if (activateBotRegexp.test(body.text)) {
    text = t('reactivating_bot_for_this_conversation');
    action = 'reactivateBot';
  } else if (matches = sendBotRegexp.exec(body.text)) {
    text = t('sending_message_to_the_bot') + ': ' + matches[1];
    action = 'sendBot';
  } else {
    text = '';
    action = 'showTips';
  };

  if (action != '') {
    const payload = { type: action, body: body, matches: matches, user_token: token }
    const functionName = config.slashResponseFunctionName || 'slash-response';
    try {
      if (config.awsRegion === 'local') {
        const lambda = require('./' + functionName).handler;
        lambda(payload, {}, function() {});
        console.log('Calling local function');
      }
      else {
        const lambda = new aws.Lambda({ region: config.awsRegion });
        lambdaRequest = lambda.invoke({ FunctionName: functionName, InvocationType: 'Event', Payload: JSON.stringify(payload) });
        lambdaRequest.send();
      }
    } catch (e) {}
  };
  console.log(text);
  callback(null, text);
};

exports.handler = function(event, context, callback) {
  const body = config.awsRegion === 'local' ? event.body : qs.parse(decodeURIComponent(event.body));
  const teamConfig = getTeamConfig(body.team_id);
  if (body.token === teamConfig.verificationToken) {
    if (/^bot /.test(body.text) || body.text === '') {
      process(body, '', callback);
    }
    else {
      getCheckSlackUser(body.user_id,
        function(err) {
          console.log('Error when trying to identify Slack user: ' + util.inspect(err));
          permissionError(callback);
        },
        function(token) {
          console.log('Successfully identified as Slack user with token: ' + token);
          process(body, token, callback);
      });
    }
  } else {
    console.log('Invalid request token: ' + body.token);
    permissionError(callback);
  }
};
