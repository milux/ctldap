FROM node:18-alpine
LABEL maintainer="Michael Lux <michi.lux@gmail.com>"

WORKDIR /app
RUN chown node:node /app
USER node

COPY --chown=node:node package.json .
COPY --chown=node:node yarn.lock .
COPY --chown=node:node .yarnrc.yml .
COPY --chown=node:node .yarn ./.yarn
RUN yarn install

COPY --chown=node:node *.js .
COPY --chown=node:node ctldap.yml .

EXPOSE 1389

ENV DEBUG ""
ENV IS_DN_LOWER_CASE true
ENV IS_EMAIL_LOWER_CASE true
ENV LDAP_USER root
ENV LDAP_PW XXXXXXXXXXXXXXXXXXXX
ENV LDAP_PW_BCRYPT ""
ENV LDAP_BASE_DN churchtools
ENV LDAP_IP 0.0.0.0
ENV LDAP_PORT 1389
ENV CT_URI https://mysite.church.tools/
ENV API_TOKEN ""
ENV CACHE_LIFETIME_MS 10000

CMD ["node", "ctldap.js"]
