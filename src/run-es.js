const fs = require('fs');
const nconf = require('nconf');
const esUtils = require('./v2/es-utils');

/* eslint no-sync: 0 */
class Elastic {
  constructor() {
    this.env = nconf.get('env');
    this.es = new esUtils.ESClass();
    this.currVer = 0;
    this.newVer = this.env.APP_VERSION ? parseInt(this.env.APP_VERSION.replace(/\./g, ''), 10) : 0;
  }

  async setup() {
    this.esHostPort = `${this.env.ES_HOST}:${this.env.ES_PORT}`;
    try {
      this.es.logElastic('debug', `[WAIT] waiting for Elasticsearch healthy state ...`);
      await this.es.waitPort(60000);
      await this.es.healthy(60000, 'yellow');
      this.esInfo = await this.es.info();
      this.es.logElastic('debug', `[READY] - [Elasticsearch v.${this.esInfo.version.number}] is up!`);
      nconf.set('env:ES_VERSION', this.esInfo.version.number);
    } catch (err) {
      if (err.hasOwnProperty('path') && err.path === '/_cluster/health' && err.body.status === 'red') {
        this.es.logElastic('error', `[ERROR] unhealthy [status=RED]!! Check ES logs for issues!`);
      } else {
        this.es.logElastic('error', `[ERROR] message: ${err.message}`);
      }
      return;
    }
    nconf.set('env:useES', true);
    await this.checkVer();
    return;
  }

  async checkVer() {
    this.es.logElastic('debug', `[UPGRADE] checking if upgrades are needed ...`);
    const currTemplate = await this.es.getTemplate(this.env.INDEX_PERF);

    if (
      currTemplate &&
      currTemplate.hasOwnProperty(this.env.INDEX_PERF) &&
      currTemplate[this.env.INDEX_PERF].hasOwnProperty('version')
    ) {
      this.currVer = currTemplate[this.env.INDEX_PERF].version;
    }
    let importFile = fs.readFileSync('./.kibana_items.json', 'utf8');
    this.newVer = parseInt(nconf.get('env:APP_VERSION').replace(/\./g, ''), 10) || this.currVer;

    if (!this.currVer || this.newVer > this.currVer || nconf.get('es_upgrade') === true) {
      const replText = nconf.get('env:KB_RENAME');
      if (replText && typeof replText === 'string') {
        importFile = importFile.replace(/TIMINGS/g, replText.toUpperCase());
      }
      this.doUpgrade(JSON.parse(importFile));
    } else {
      this.es.logElastic('debug', `[UPGRADE] Kibana items already up-to-date`);
    }
  }

  async doUpgrade(importJson) {
    // Import/update latest visualizations and dashboards
    this.es.logElastic('debug', `[UPGRADE] upgrading Kibana items ... [Force: ${nconf.get('es_upgrade')} ` +
      `- New: ${!this.currVer} - Upgr: ${this.currVer < this.newVer}]`);

    const esResponse = await this.es.kbImport(importJson);
    if (esResponse === true) {
      this.es.logElastic('debug', `[IMPORT] - imported/updated ${Object.keys(importJson).length} Kibana item(s)!`);
      await this.es.defaultIndex(this.env.INDEX_PERF + '*', this.env.ES_VERSION);
    }

    // Make sure the latest template is present
    const templateJson = require('../.es_template.js');
    templateJson.version = this.newVer;
    await this.es.putTemplate('cicd-perf', templateJson);
    return;
  }
}

module.exports.Elastic = Elastic;
