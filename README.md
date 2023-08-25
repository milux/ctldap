# ctldap 3.1.1 - LDAP Wrapper for ChurchTools

This software acts as an LDAP server for ChurchTools 3

**This software was tested in a common environment, yet no warranties of any kind!** 

# Installation
`Docker` is required to run `ctldap`, `docker compose plugin` is strongly recommended.

The old installation methods are discouraged and won't be supported any further.

## Migration from version 2.x to 3.x
Version 3.0.0 includes some breaking changes in the configuration format and some parameters.
Assuming Docker setup, the necessary adaptations are not that difficult, though.

- The `CT_USER` and `CT_PW` env vars have been replaced by `API_TOKEN`. You should remove these.
- You can also delete `LDAP_PW_BCRYPT`. The password encoding is now auto-detected.
  ctldap 3.0.0 supports plaintext, bcrypt hashes, and argon2 hashes (recommended) for your LDAP admin user.
- Specify `API_TOKEN`. You can obtain your token as follows:
  - Login with **your CT LDAP user** via https://your.ct.domain/api > `General` > `login`
  (copy the `personId` from the shown output!)
  - Fetch the token via `Person` > `/persons/{personId}/logintoken`
- Apply the typo fix on `CACHE_LIVETIME` by renaming it to `CACHE_LIFETIME_MS`.

# Usage
The LDAP DNs depend on your configuration. Let's assume the following configuration:
```
ldap_user=root
ldap_password=0a1b2c3d4e5f6g7h8i9j
ldap_base_dn=churchtools
```
For such a configuration, the
- admin DN for initial binding is `cn=root,ou=users,o=churchtools`
- password for initial binding is `0a1b2c3d4e5f6g7h8i9j`
- users are found in the organizational unit `ou=users,o=churchtools`
- groups are found in the organizational unit `ou=groups,o=churchtools`