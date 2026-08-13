ARG BUILD_FROM
FROM ${BUILD_FROM}

# Add text-field focus tracking and forward the panel keyboard to Chromium.
# The compiled bridge remains supplied by BUILD_FROM.
COPY app/browser_ctl.js /app/browser_ctl.js

ARG BUILD_ARCH
ARG BUILD_VERSION
LABEL \
  io.hass.name="Elecrow ESP32P4 interface" \
  io.hass.type="addon" \
  io.hass.arch="${BUILD_ARCH}" \
  io.hass.version="${BUILD_VERSION}"
