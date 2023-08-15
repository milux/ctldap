/**
 * ctldap - ChurchTools LDAP-Wrapper 3.0
 * @copyright 2017-2023 Michael Lux
 * @licence GNU/GPL v3.0
 */
import { readYamlEnvSync } from "yaml-env-defaults";
import { CtldapSite } from "./ctldap-site.js";

export class CtldapConfig {

    /**
     * CtldapConfig constructor.
     */
    constructor() {
        const yaml = readYamlEnvSync('./ctldap.yml');
        const config = yaml.config;
        this.trace = CtldapConfig.asOptionalBool(config.trace);
        this.debug = this.trace || CtldapConfig.asOptionalBool(config.debug);
        this.ldapIp = config.ldapIp;
        this.ldapPort = config.ldapPort;

        if (typeof config.cacheLifetime !== 'number' && isNaN(config.cacheLifetime)) {
            this.cacheLifetime = 300000;  // 5 minutes
        } else {
            this.cacheLifetime = Number(config.cacheLifetime);
        }
        this.ldapUser = config.ldapUser;
        this.ldapPassword = config.ldapPassword;
        this.ctUri = config.ctUri;
        this.apiToken = config.apiToken;
        this.specialGroupMappings = config.specialGroupMappings || {};
        this.dnLowerCase = CtldapConfig.asOptionalBool(config.dnLowerCase);
        this.emailLowerCase = CtldapConfig.asOptionalBool(config.emailLowerCase);
        this.emailsUnique = CtldapConfig.asOptionalBool(config.emailsUnique);
        this.ldapCertFilename = config.ldapCertFilename;
        this.ldapKeyFilename = config.ldapKeyFilename;
        this.ldapBaseDn = config.ldapBaseDn;
        // Configure sites
        const sites = yaml.sites || {};
        // If ldapBaseDn is set, create a site from the global config properties.
        if (config.ldapBaseDn) {
            sites[config.ldapBaseDn] = {
                ldapUser: config.ldapUser,
                ldapPassword: config.ldapPassword,
                ctUri: config.ctUri,
                apiToken: config.apiToken,
                specialGroupMappings: config.specialGroupMappings
            }
        }
        this.sites = Object.keys(sites).map((siteName) => new CtldapSite(this, siteName, sites[siteName]));
    }

    static asOptionalBool (val) {
        if (val === undefined) {
            return undefined;
        }
        return (val || 'false').toLowerCase() !== 'false';
    }
}