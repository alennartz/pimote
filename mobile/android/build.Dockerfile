# Self-contained Android build toolchain for the pimote native client.
#
# Used only for compiling the Android app (gradle + sdkmanager + JDK).
# The host runs adb for installs/wireless deployment; this image never
# touches a device.
#
# Usage: see mobile/android/README.md or top-level Makefile `android-*` targets.

FROM eclipse-temurin:17-jdk-jammy

ARG ANDROID_CMDLINE_TOOLS_VERSION=11076708
ARG ANDROID_BUILD_TOOLS_VERSION=34.0.0
ARG ANDROID_PLATFORM_VERSION=34

ENV ANDROID_HOME=/opt/android-sdk
ENV ANDROID_SDK_ROOT=${ANDROID_HOME}
ENV PATH="${ANDROID_HOME}/cmdline-tools/latest/bin:${ANDROID_HOME}/platform-tools:${PATH}"
ENV GRADLE_USER_HOME=/workspace/.gradle-cache

RUN apt-get update && apt-get install -y --no-install-recommends \
    unzip \
    wget \
    git \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Android command-line tools.
RUN mkdir -p ${ANDROID_HOME}/cmdline-tools \
    && cd ${ANDROID_HOME}/cmdline-tools \
    && wget -q https://dl.google.com/android/repository/commandlinetools-linux-${ANDROID_CMDLINE_TOOLS_VERSION}_latest.zip -O cmdline-tools.zip \
    && unzip -q cmdline-tools.zip \
    && rm cmdline-tools.zip \
    && mv cmdline-tools latest

# Accept SDK licenses and install platform + build tools.
RUN yes | sdkmanager --licenses > /dev/null 2>&1 || true \
    && sdkmanager \
        "platform-tools" \
        "platforms;android-${ANDROID_PLATFORM_VERSION}" \
        "build-tools;${ANDROID_BUILD_TOOLS_VERSION}"

# Make the SDK readable by any uid the container runs as (host bind mount may map to host uid).
RUN chmod -R a+rX ${ANDROID_HOME}

WORKDIR /workspace
