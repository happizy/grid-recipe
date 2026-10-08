# syntax=docker/dockerfile:1

FROM debian:bookworm-slim AS renderer-assets

ARG TARGETARCH
ARG TYPST_VERSION=0.15.1
ARG ALEGREYA_REVISION=40478177239cbf3bac07908ef0738afee0f72be7

RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates curl xz-utils \
    && rm -rf /var/lib/apt/lists/*

RUN case "$TARGETARCH" in \
      amd64) typst_target="x86_64-unknown-linux-musl" ;; \
      arm64) typst_target="aarch64-unknown-linux-musl" ;; \
      *) echo "Unsupported Docker architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac \
    && mkdir -p /opt/typst \
    && curl --fail --location --retry 3 \
      "https://github.com/typst/typst/releases/download/v${TYPST_VERSION}/typst-${typst_target}.tar.xz" \
      --output /tmp/typst.tar.xz \
    && tar --extract --xz --file /tmp/typst.tar.xz --directory /opt/typst --strip-components=1 \
    && /opt/typst/typst --version

RUN mkdir -p /opt/fonts/alegreya \
    && curl --fail --location --retry 3 \
      "https://raw.githubusercontent.com/google/fonts/${ALEGREYA_REVISION}/ofl/alegreya/Alegreya%5Bwght%5D.ttf" \
      --output "/opt/fonts/alegreya/Alegreya[wght].ttf" \
    && curl --fail --location --retry 3 \
      "https://raw.githubusercontent.com/google/fonts/${ALEGREYA_REVISION}/ofl/alegreya/OFL.txt" \
      --output /opt/fonts/alegreya/OFL.txt


FROM node:22-bookworm-slim AS frontend

WORKDIR /build/web
COPY web/package*.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build


FROM python:3.13-slim-bookworm AS application

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HOME=/tmp \
    XDG_CACHE_HOME=/tmp/.cache \
    TYPST_BIN=/usr/local/bin/typst \
    RENDER_TIMEOUT_SECONDS=30

RUN apt-get update \
    && apt-get install --yes --no-install-recommends fontconfig \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --home-dir /home/grid-recipe --shell /usr/sbin/nologin grid-recipe

COPY --from=renderer-assets /opt/typst/typst /usr/local/bin/typst
COPY --from=renderer-assets /opt/fonts/alegreya /usr/local/share/fonts/alegreya

RUN fc-cache --force \
    && typst --version \
    && typst fonts | grep --fixed-strings --line-regexp "Alegreya"

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir --requirement requirements.txt

COPY --chown=grid-recipe:grid-recipe grid_recipe.py web_app.py example_recipe.json ./
COPY --from=frontend --chown=grid-recipe:grid-recipe /build/web/dist ./web/dist

USER grid-recipe

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=6s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=5)" || exit 1

CMD ["gunicorn", "--bind", "0.0.0.0:8000", "--workers", "2", "--threads", "1", "--timeout", "45", "--access-logfile", "-", "--error-logfile", "-", "web_app:app"]
