import ldapjs from "ldapjs";
import getAttributeValue from "@ldapjs/filter/lib/utils/get-attribute-value.js";
import testValues from "@ldapjs/filter/lib/utils/test-values.js";

export const patchLdapjsFilters = () => {
    /**
     * Case-insensitive matching in SubstringFilter, overrides "matches" of corresponding prototype.
     * Mainly resembles source code from @ldapjs/filter 2.1.0.
     */
    ldapjs.filters.SubstringFilter.prototype.matches = function (obj, strictAttrCase) {
        if (Array.isArray(obj) === true) {
            for (const attr of obj) {
                if (Object.prototype.toString.call(attr) !== '[object LdapAttribute]') {
                    throw Error('array element must be an instance of LdapAttribute')
                }
                if (this.matches(attr, strictAttrCase) === true) {
                    return true
                }
            }
            return false
        }

        const targetValue = getAttributeValue({
            sourceObject: obj,
            attributeName: this.attribute,
            strictCase: strictAttrCase
        })

        if (targetValue === undefined || targetValue === null) {
            return false
        }

        const escapeRegExp = str => str.replace(/[\-\[\]\/{}()*+?.\\^$|]/g, '\\$&'); // eslint-disable-line
        let re = ''

        if (this.initial) { re += '^' + escapeRegExp(this.initial) + '.*' }
        this.any.forEach(function (s) {
            re += escapeRegExp(s) + '.*'
        })
        if (this.final) { re += escapeRegExp(this.final) + '$' }

        // Functional change here: Add case-insensitive-flag
        const matcher = new RegExp(re, 'i')
        return testValues({
            rule: v => matcher.test(v),
            value: targetValue
        })
    };

    /**
     * Case-insensitive matching in EqualityFilter, overrides "matches" of corresponding prototype.
     * Mainly resembles source code from @ldapjs/filter 2.1.0.
     */
    ldapjs.filters.EqualityFilter.prototype.matches = function (obj, strictAttrCase = false) {
        if (Array.isArray(obj) === true) {
            for (const attr of obj) {
                if (Object.prototype.toString.call(attr) !== '[object LdapAttribute]') {
                    throw Error('array element must be an instance of LdapAttribute')
                }
                if (this.matches(attr, strictAttrCase) === true) {
                    return true
                }
            }
            return false
        }

        let testValue = this.value

        // Always perform case-insensitive value comparison
        const targetAttribute = getAttributeValue({
            sourceObject: obj,
            attributeName: this.attribute,
            strictCase: this.attribute.toLowerCase() !== 'objectclass' && strictAttrCase
        })
        testValue = testValue.toLowerCase()
        return testValues({
            rule: v => testValue === v?.toLowerCase(),
            value: targetAttribute
        })
    };
};
