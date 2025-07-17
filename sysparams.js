let sysParams = {};

function setParams(params) {
  sysParams = { ...params };
}

function getParams() {
  return sysParams;
}

module.exports = { setParams, getParams };