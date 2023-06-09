FROM node:14-slim as builder

RUN apt-get update && apt-get install -y --no-install-recommends g++ make python3 jq


WORKDIR /builder

COPY package.json .
COPY yarn.lock .
COPY lerna.json .

COPY packages/backend-core/package.json packages/backend-core/
COPY packages/bbui/package.json packages/bbui/
COPY packages/builder/package.json packages/builder/
COPY packages/cli/package.json packages/cli/
COPY packages/client/package.json packages/client/
COPY packages/frontend-core/package.json packages/frontend-core/
COPY packages/sdk/package.json packages/sdk/
COPY packages/server/package.json packages/server/
COPY packages/shared-core/package.json packages/shared-core/
COPY packages/string-templates/package.json packages/string-templates/
COPY packages/types/package.json packages/types/
COPY packages/worker/package.json packages/worker/
COPY packages/pro/packages/pro/package.json packages/pro/packages/pro/

# We will never want to sync pro, but the script is still required
RUN mkdir scripts && echo '' > scripts/syncProPackage.js
RUN yarn install --frozen-lockfile && yarn cache clean

COPY packages/ packages/
COPY scripts/build.js scripts/build.js
COPY nx.json .

RUN yarn build --projects=@budibase/worker

COPY scripts/clean-dependencies.sh scripts/clean-dependencies.sh
RUN ./scripts/clean-dependencies.sh packages/worker/package.json


FROM node:14-alpine as runner

LABEL com.centurylinklabs.watchtower.lifecycle.pre-check="scripts/watchtower-hooks/pre-check.sh"
LABEL com.centurylinklabs.watchtower.lifecycle.pre-update="scripts/watchtower-hooks/pre-update.sh"
LABEL com.centurylinklabs.watchtower.lifecycle.post-update="scripts/watchtower-hooks/post-update.sh"
LABEL com.centurylinklabs.watchtower.lifecycle.post-check="scripts/watchtower-hooks/post-check.sh"

WORKDIR /app

# handle node-gyp
RUN apk add --no-cache --virtual .gyp python3 make g++
RUN yarn global add pm2


COPY --from=builder /builder/package.json .
COPY --from=builder /builder/yarn.lock .
COPY --from=builder /builder/packages/worker/package.json packages/worker/

# We will never want to sync pro, but the script is still required
RUN mkdir scripts && echo '' > scripts/syncProPackage.js

# We want the clean in the same
RUN yarn install --production=true --frozen-lockfile && apk del .gyp \
    && yarn cache clean

COPY --from=builder /builder/packages/worker/dist packages/worker/dist

COPY lerna.json .

WORKDIR /app/packages/worker

COPY packages/worker/docker_run.sh .

EXPOSE 4001

# have to add node environment production after install
# due to this causing yarn to stop installing dev dependencies
# which are actually needed to get this environment up and running
ENV NODE_ENV=production
ENV CLUSTER_MODE=${CLUSTER_MODE}
ENV SERVICE=worker-service
ENV POSTHOG_TOKEN=phc_bIjZL7oh2GEUd2vqvTBH8WvrX0fWTFQMs6H5KQxiUxU
ENV TENANT_FEATURE_FLAGS=*:LICENSING,*:USER_GROUPS,*:ONBOARDING_TOUR
ENV ACCOUNT_PORTAL_URL=https://account.budibase.app

CMD ["./docker_run.sh"]
