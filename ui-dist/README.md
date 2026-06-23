# Placeholder so `COPY ui-dist` in the Dockerfile always succeeds.
# CI stages mmc-workflow's built dist/ here before `docker build`;
# locally this dir stays empty and the server runs engine-only
# (staticUi.ts no-ops when index.html is absent).
