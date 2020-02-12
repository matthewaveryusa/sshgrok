#!

function get_random_port {
  python -c 'import socket; s=socket.socket(); s.bind(("", 0)); print(s.getsockname()[1]); s.close()'
}

proxy=$1
echo starting proxy server for $proxy

#shitty and racy
server_port=$(get_random_port)
tunnel_port=$(get_random_port)

echo "starting local server on $server_port"
python -m SimpleHTTPServer $server_port&
sleep 2

echo "starting websocket tunnel on port $tunnel_port"
wstunnel -t $tunnel_port:$proxy-server.averymatt.com:443 wss://$proxy-server.averymatt.com:443&
sleep 2

echo "starting ssh tunnel on going to localhost:$tunnel_port and foward-proxing requests to the server on port $server_port"
ssh -vvv -N -R localhost:3000:localhost:$server_port -i /root/.ssh/id_rsa sshgrok@localhost -p$tunnel_port&
