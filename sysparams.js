// Default values
const defaultParams = {
  modelName: 'gpt-4o',
  historyLength: 10,
  temperature: 0.2,
  numTopFiles: 10,
  numTopLinks: 10,
};

let sysParams = { ...defaultParams };

function setParams(params) {
  sysParams = { ...params };
}

function getParams() {
  return sysParams;
}

module.exports = { setParams, getParams };