FROM alpine:edge
WORKDIR /root
RUN apk add --no-cache shadow nodejs npm
RUN npm install -g wstunnel
RUN useradd --shell /bin/false -p'*' -m sshgrok
RUN apk add --no-cache openssh
RUN mkdir -p /home/sshgrok/.ssh
RUN touch /home/sshgrok/.ssh/authorized_keys
RUN ssh-keygen -q -N "" -t ed25519 -f /etc/ssh/host_ed25519
RUN chown sshgrok:sshgrok /home/sshgrok/.ssh/authorized_keys
RUN chmod 600 /home/sshgrok/.ssh/authorized_keys
COPY sshd_config /etc/ssh/sshd_config
COPY run.sh /root/run.sh
STOPSIGNAL SIGTERM
CMD ["sh","run.sh"]
