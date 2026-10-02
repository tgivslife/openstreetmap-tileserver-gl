#!/usr/bin/env bash
# Build the Docker images, tagged with the version in package.json and labelled with their provenance.
#
#   npm run images:build                    # all three: full, light, light-s3
#   npm run images:build -- light light-s3  # only these
#   PUSH=1 npm run images:build             # build, then push every tag built
#
# Tags: <REPO>:<version>, <REPO>:<version>-light, <REPO>:<version>-light-s3 (REPO defaults to stsdockerhub/tileserver-gl).
# Labels: org.opencontainers.image.version / .revision (git commit, with -dirty for uncommitted changes) / .created,
# and tileserver-gl.upstream.version from package.json's upstreamVersion. Read them back with
#   docker inspect -f '{{json .Config.Labels}}' <image>
# light-s3 is built from ../tileserver-gl-data on top of the light image of the same version.
set -euo pipefail
cd "$(dirname "$0")/.."

REPO=${REPO:-stsdockerhub/tileserver-gl}
VERSION=$(node -p "require('./package.json').version")
UPSTREAM_VERSION=$(node -p "require('./package.json').upstreamVersion")
REVISION=$(git rev-parse --short HEAD)
if [[ -n "$(git status --porcelain -- . ../tileserver-gl-data)" ]]; then
  REVISION="$REVISION-dirty"
fi
CREATED=$(date -u +%Y-%m-%dT%H:%M:%SZ)
targets=("$@")
((${#targets[@]})) || targets=(full light light-s3)

labels=(--build-arg "VERSION=$VERSION" --build-arg "UPSTREAM_VERSION=$UPSTREAM_VERSION"
        --build-arg "REVISION=$REVISION" --build-arg "CREATED=$CREATED")
built=()
for target in "${targets[@]}"; do
  case "$target" in
    full)
      tag="$REPO:$VERSION"
      docker build -f Dockerfile "${labels[@]}" -t "$tag" . ;;
    light)
      tag="$REPO:$VERSION-light"
      docker build -f Dockerfile_light "${labels[@]}" -t "$tag" . ;;
    light-s3)
      tag="$REPO:$VERSION-light-s3"
      if ! docker image inspect "$REPO:$VERSION-light" >/dev/null 2>&1; then
        echo "light-s3 needs $REPO:$VERSION-light; build it first (npm run images:build -- light light-s3)" >&2
        exit 1
      fi
      docker build -f Dockerfile_light_s3 "${labels[@]}" --build-arg "BASE=$REPO:$VERSION-light" -t "$tag" ../tileserver-gl-data ;;
    *)
      echo "unknown image \"$target\" (use full, light or light-s3)" >&2
      exit 1 ;;
  esac
  built+=("$tag")
  echo "built $tag ($REVISION)"
done

if [[ "${PUSH:-}" == "1" ]]; then
  for tag in "${built[@]}"; do
    docker push "$tag"
  done
fi
