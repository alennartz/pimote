# Self-contained Android build toolchain for the pimote native client.
#
# Compiles and tests only. Wireless ADB, pairing, and installs run on the host,
# because pairing keys are host state.
#
# Values come from versions.env through tools/android-image.

ARG ANDROID_BASE_IMAGE
ARG ANDROID_BASE_IMAGE_DIGEST
FROM ${ANDROID_BASE_IMAGE}@${ANDROID_BASE_IMAGE_DIGEST}

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ARG ANDROID_JDK_MAJOR_VERSION
ARG ANDROID_CMDLINE_TOOLS_VERSION
ARG ANDROID_CMDLINE_TOOLS_REVISION
ARG ANDROID_PLATFORM_VERSION
ARG ANDROID_BUILD_TOOLS_VERSION

ENV ANDROID_HOME=/opt/android-sdk \
    ANDROID_SDK_ROOT=/opt/android-sdk \
    GRADLE_USER_HOME=/cache/gradle

RUN apt-get update \
    && apt-get install --no-install-recommends --yes \
        ca-certificates \
        curl \
        unzip \
    && rm -rf /var/lib/apt/lists/*

# Android command-line tools. The archive unpacks a cmdline-tools directory that
# sdkmanager expects at cmdline-tools/latest.
RUN set -eux; \
    mkdir -p "${ANDROID_HOME}/cmdline-tools"; \
    curl --fail --silent --show-error --location \
        "https://dl.google.com/android/repository/commandlinetools-linux-${ANDROID_CMDLINE_TOOLS_VERSION}_latest.zip" \
        --output /tmp/cmdline-tools.zip; \
    unzip -q /tmp/cmdline-tools.zip -d "${ANDROID_HOME}/cmdline-tools"; \
    mv "${ANDROID_HOME}/cmdline-tools/cmdline-tools" "${ANDROID_HOME}/cmdline-tools/latest"; \
    rm /tmp/cmdline-tools.zip

ENV PATH="${ANDROID_HOME}/cmdline-tools/latest/bin:${PATH}"

RUN set -eux; \
    sdkmanager --licenses < <(yes); \
    sdkmanager \
        "platforms;android-${ANDROID_PLATFORM_VERSION}" \
        "build-tools;${ANDROID_BUILD_TOOLS_VERSION}"

# Fail the build when the installed SDK disagrees with a pin.
RUN set -eux; \
    cmdline_tools_revision=$(sed -n 's/^Pkg.Revision[[:space:]]*=[[:space:]]*//p' "${ANDROID_HOME}/cmdline-tools/latest/source.properties"); \
    test "$cmdline_tools_revision" = "$ANDROID_CMDLINE_TOOLS_REVISION"; \
    platform_api=$(sed -n 's/^AndroidVersion.ApiLevel[[:space:]]*=[[:space:]]*//p' "${ANDROID_HOME}/platforms/android-${ANDROID_PLATFORM_VERSION}/source.properties"); \
    test "$platform_api" = "$ANDROID_PLATFORM_VERSION"; \
    build_tools_revision=$(sed -n 's/^Pkg.Revision[[:space:]]*=[[:space:]]*//p' "${ANDROID_HOME}/build-tools/${ANDROID_BUILD_TOOLS_VERSION}/source.properties"); \
    test "$build_tools_revision" = "$ANDROID_BUILD_TOOLS_VERSION"; \
    java_major=$(java -version 2>&1 | sed -n 's/.*version "\([0-9]*\).*/\1/p'); \
    test "$java_major" = "$ANDROID_JDK_MAJOR_VERSION"; \
    sdkmanager --version

# Containers run as the caller's uid, so the SDK and the cache root must be
# readable and writable by any uid.
RUN mkdir -p "${GRADLE_USER_HOME}" \
    && chmod -R a+rwX /cache \
    && chmod -R a+rX "${ANDROID_HOME}"

WORKDIR /workspace
