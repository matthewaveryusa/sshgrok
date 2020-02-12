#!
echo $SSH_PUBKEY > /home/sshgrok/.ssh/authorized_keys
/usr/sbin/sshd
wstunnel -s 0.0.0.0:4022 -t localhost:22
