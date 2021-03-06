const btoa = require('btoa');
const fetch = require('node-fetch');
let aws = require('aws-sdk');
const awsMock = require('aws-sdk-mock');
let config = require('./config');
const slash = require('./slash');

const { sleep, callCheckApi, buildRandomString } = require('./test-helpers');

jest.setTimeout(120000);

const apiData = async () => {
  await callCheckApi('new_api_key', { access_token: config.checkApi.apiKey });
  await sleep(1);

  const uid = buildRandomString();
  const token = buildRandomString();
  const email = buildRandomString() + '@test.com';
  const user = await callCheckApi('user', { provider: 'slack', uid, token, is_admin: true });

  return user;
};

test('verify input format on call', async () => {
  const user = await apiData();
  const data = { body: "team_id=T12345ABC&token=123456abcdef&user_id=" + user.data.uid + "&text=unknown"};
  const callback = jest.fn();

  let outputData = '';
  storeLog = inputs => (outputData += inputs);
  console['log'] = jest.fn(storeLog);

  slash.handler(data, null, callback);
  await sleep(3);
  expect(callback).toHaveBeenCalledWith(null, '');
});

test('verify url and project on call', async () => {
  const user = await apiData();
  const data = { body: "team_id=T12345ABC&token=123456abcdef&user_id=" + user.data.uid + "&text=<https://ca.ios.ba/>"};
  const callback = jest.fn();

  let outputData = '';
  storeLog = inputs => (outputData += inputs);
  console['log'] = jest.fn(storeLog);

  slash.handler(data, null, callback);
  await sleep(3);
  expect(callback).toHaveBeenCalledWith(null, expect.stringContaining('Sending URL to Check'));
});

test('verify set and valid check link on call', async () => {
  const projectUrl = config.checkWeb.url + '/my-team/project/1';
  const user = await apiData();
  const data = { body: "team_id=T12345ABC&token=123456abcdef&user_id=" + user.data.uid + "&text=set <" + projectUrl + ">"};
  const callback = jest.fn();

  let outputData = '';
  storeLog = inputs => (outputData += inputs);
  console['log'] = jest.fn(storeLog);

  slash.handler(data, null, callback);
  await sleep(3);
  expect(callback).toHaveBeenCalledWith(null, expect.stringContaining('Setting project...'));
});

test('verify set and invalid check link on call', async () => {
  const projectUrl = 'http://invalid-domain/my-team/project/1';
  const user = await apiData();
  const data = { body: "team_id=T12345ABC&token=123456abcdef&user_id=" + user.data.uid + "&text=set <" + projectUrl + ">"};
  const callback = jest.fn();

  let outputData = '';
  storeLog = inputs => (outputData += inputs);
  console['log'] = jest.fn(storeLog);

  slash.handler(data, null, callback);
  await sleep(3);
  expect(callback).toHaveBeenCalledWith(null, expect.stringContaining('Invalid project URL: ' + projectUrl));
});

test('verify show on call', async () => {
  const user = await apiData();
  const data = { body: "team_id=T12345ABC&token=123456abcdef&user_id=" + user.data.uid + "&text=show"};
  const callback = jest.fn();
  const context = jest.fn();

  let outputData = '';
  storeLog = inputs => (outputData += inputs);
  console['log'] = jest.fn(storeLog);

  slash.handler(data, context, callback);
  await sleep(3);
  expect(callback).toHaveBeenCalledWith(null, expect.stringContaining('Getting project'));
});

test('ignore show that is not in the beggining of command', async () => {
  const user = await apiData();
  const data = { body: "team_id=T12345ABC&token=123456abcdef&user_id=" + user.data.uid + "&text=<http://www.commitstrip.com/en/2014/08/19/when-a-colleague-put-his-fingers-on-my-screen-to-show-me-something>"};
  const callback = jest.fn();
  const context = jest.fn();

  let outputData = '';
  storeLog = inputs => (outputData += inputs);
  console['log'] = jest.fn(storeLog);

  slash.handler(data, context, callback);
  await sleep(3);
  expect(callback).toHaveBeenCalledWith(null, expect.stringContaining('Sending URL to'));
});

test('accept empty command on call', async () => {
  const user = await apiData();
  const data = { body: "team_id=T12345ABC&token=123456abcdef&user_id=" + user.data.uid + "&text="};
  const callback = jest.fn();

  let outputData = '';
  storeLog = inputs => (outputData += inputs);
  console['log'] = jest.fn(storeLog);

  slash.handler(data, null, callback);
  await sleep(3);
  expect(callback).toHaveBeenCalledWith(null, '');
});

test('accept help command on call', async () => {
  const user = await apiData();
  const data = { body: "team_id=T12345ABC&token=123456abcdef&user_id=" + user.data.uid + "&text=help"};
  const callback = jest.fn();

  let outputData = '';
  storeLog = inputs => (outputData += inputs);
  console['log'] = jest.fn(storeLog);

  slash.handler(data, null, callback);
  await sleep(3);

  expect(callback).toHaveBeenCalledWith(null, '');
});

test('return error if verification token is not valid', async () => {
  let outputData = '';
  storeLog = inputs => (outputData += inputs);
  console['log'] = jest.fn(storeLog);

  const data = { body: "team_id=T12345ABC&token=invalid"};
  const callback = jest.fn();
  slash.handler(data, null, callback);
  expect(outputData).toMatch('Invalid request token');
  expect(callback).toHaveBeenCalledWith(null, expect.stringContaining('do not have the permission'));
});

test('return error if Slack user cannot be identified', async () => {
  const data = { body: "team_id=T12345ABC&token=123456abcdef&user_id=invalid"};
  const callback = jest.fn();

  let outputData = '';
  storeLog = inputs => (outputData += inputs);
  console['log'] = jest.fn(storeLog);

  slash.handler(data, null, callback);
  await sleep(3);
  expect(outputData).toMatch('Error when trying to identify Slack user');
  expect(callback).toHaveBeenCalledWith(null, expect.stringContaining('do not have the permission'));
});

test('call slash-response by default when not present on config', async () => {
  let outputData = '';
  storeLog = inputs => (outputData += inputs);
  console['log'] = jest.fn(storeLog);
  const functionName = config.slashResponseFunctionName;
  config.slashResponseFunctionName = false;

  const user = await apiData();
  const data = { body: "team_id=T12345ABC&token=123456abcdef&user_id=" + user.data.uid + "&text=help"};

  const callback = jest.fn();
  awsMock.mock('Lambda', 'invoke', function({}) { console.log('AWS Mocked Method'); });
  slash.handler(data, null, callback);
  await sleep(3);

  expect(outputData).toMatch('AWS Mocked Method');
  expect(callback).toHaveBeenCalledWith(null, '');
  config.slashResponseFunctionName = functionName;
});

test('reactivate Smooch bot', async () => {
  const user = await apiData();
  const data = { body: "team_id=T12345ABC&token=123456abcdef&user_id=" + user.data.uid + "&text=bot activate"};
  const callback = jest.fn();
  const context = jest.fn();

  let outputData = '';
  storeLog = inputs => (outputData += inputs);
  console['log'] = jest.fn(storeLog);

  slash.handler(data, context, callback);
  await sleep(3);
  expect(callback).toHaveBeenCalledWith(null, expect.stringContaining('Reactivating bot for this conversation'));
});

test('send message to Smooch bot', async () => {
  const user = await apiData();
  const data = { body: "team_id=T12345ABC&token=123456abcdef&user_id=" + user.data.uid + "&text=bot send Test"};
  const callback = jest.fn();
  const context = jest.fn();

  let outputData = '';
  storeLog = inputs => (outputData += inputs);
  console['log'] = jest.fn(storeLog);

  slash.handler(data, context, callback);
  await sleep(3);
  expect(callback).toHaveBeenCalledWith(null, expect.stringContaining('Sending message to the bot'));
});

test('call Lambda function locally when calling command', async () => {
  const user = await apiData();
  const data = { body: { team_id: 'T12345ABC', token: '123456abcdef', user_id: user.data.uid, text: 'help' } };
  const callback = jest.fn();
  const context = jest.fn();

  let outputData = '';
  storeLog = inputs => (outputData += inputs);
  console['log'] = jest.fn(storeLog);
 
  const functionName = config.slashResponseFunctionName;
  config.slashResponseFunctionName = false;
  const awsRegion = config.awsRegion;
  config.awsRegion = 'local'; 

  slash.handler(data, context, callback);
  await sleep(3);
  
  expect(callback).toHaveBeenCalledWith(null, '');
  expect(outputData).toMatch('Calling local function');
  
  config.slashResponseFunctionName = functionName;
  config.awsRegion = awsRegion;
});
