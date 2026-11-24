# A stand-in for the release target: Amazon Linux 2023 (as on Trendigle's box) with the tools
# shukka-release.sh relies on, a fake systemctl (no systemd in a container) and a fake aws CLI
# that copies from /fake-s3/<bucket>/<key> instead of S3.
FROM amazonlinux:2023
RUN dnf install -y -q tar gzip util-linux findutils shadow-utils procps-ng \
 && dnf clean all \
 && useradd --system --home-dir /nonexistent --shell /usr/sbin/nologin app \
 && mkdir -p /etc/systemd/system /fake-s3
COPY shims/systemctl /usr/local/bin/systemctl
COPY shims/aws /usr/local/bin/aws
COPY fixtures/ /fixtures/
RUN chmod 755 /usr/local/bin/systemctl /usr/local/bin/aws /fixtures/*.sh
