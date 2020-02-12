sqlite3 = require("better-sqlite3");
fs = require("fs");
http = require("http");
https = require("https");
url = require("url");
qs = require("querystring");
mustache = require("mustache");
Docker = require("dockerode");
util = require("util");
const docker = new Docker({ socketPath: "/var/run/docker.sock" });

root_cname = process.env.ROOT_CNAME;
cf_api_key = process.env.CLOUDFLARE_API_KEY;
cf_email = process.env.CLOUDFLARE_EMAIL;
domain = process.env.DOMAIN;

async function https_get(url, options) {
  return new Promise((accept, reject) => {
    https.get(url, options, resp => {
      accept(resp);
    });
  });
}

async function https_delete(url, options) {
  options.method = "DELETE";
  return new Promise((accept, reject) => {
    https.request(url, options, resp => {
      accept(resp);
    });
  });
}

async function https_post(url, options, data) {
  options.method = "POST";
  return new Promise((accept, reject) => {
    const req = https.request(url, options, resp => {
      accept(resp);
    });

    req.write(data);
    req.end();
  });
}

async function json_post(url, options, data) {
  try {
    req = await https_post(url, options, data);
    body = await https_get_body(req);
  } catch (e) {
    console.log(e);
    throw e;
  }
  return JSON.parse(body.toString());
}

async function https_get_body(req) {
  return new Promise((accept, reject) => {
    chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => accept(Buffer.concat(chunks)));
    req.on("error", err => reject(err));
  });
}

async function json_get(url, options) {
  try {
    req = await https_get(url, options);
    body = await https_get_body(req);
  } catch (e) {
    console.log(e);
    throw e;
  }
  return JSON.parse(body.toString());
}

async function json_delete(url, options) {
  try {
    req = await https_delete(url, options);
    body = await https_get_body(req);
  } catch (e) {
    console.log(e);
    throw e;
  }
  return JSON.parse(body.toString());
}

async function add_dns_record(cname) {
  console.log(JSON.stringify({
      type: "CNAME",
      name: cname,
      content: root_cname,
      proxied: true
    })
  )
  const response = await json_post(
    `https://api.cloudflare.com/client/v4/zones/${cf_zoneid}/dns_records`,
    {
      headers: {
        "X-Auth-Email": cf_email,
        "X-Auth-Key": cf_api_key,
        "Content-Type": "application/json"
      }
    },
    JSON.stringify({
      type: "CNAME",
      name: cname,
      content: root_cname,
      proxied: true
    })
  );
  if(response.success === true) {
    console.log("add dns response", JSON.stringify(response), "id", response.result.id);
    return response.result.id;
  } else{
    throw new Error("add dns failed", JSON.stringify(response.errors))
  }
}

async function remove_dns_record(id) {
  const response = await json_delete(
    `https://api.cloudflare.com/client/v4/zones/${cf_zoneid}/dns_records/${id}`,
    {
      headers: {
        "X-Auth-Email": cf_email,
        "X-Auth-Key": cf_api_key,
        "Content-Type": "application/json"
      }
    }
  );
  if(response.success === true) {
    console.log("delete dns response");
  } else{
	  throw new Error("delete dns failed", JSON.stringify(response.errors))
  }
}

(async () => {
  await run();
})();

async function run() {
  cf_id = (
    await json_get(
      "https://api.cloudflare.com/client/v4/accounts?page=1&per_page=20&direction=desc",
      {
        headers: {
          "X-Auth-Email": cf_email,
          "X-Auth-Key": cf_api_key,
          "Content-Type": "application/json"
        }
      }
    )
  ).result[0].id;

  cf_zoneid = (
    await json_get(
      `https://api.cloudflare.com/client/v4/zones?name=${domain}`,
      {
        headers: {
          "X-Auth-Email": cf_email,
          "X-Auth-Key": cf_api_key,
          "Content-Type": "application/json"
        }
      }
    )
  ).result[0].id;

  cf_current_cnames = (
    await json_get(
      `https://api.cloudflare.com/client/v4/zones/${cf_zoneid}/dns_records?type=CNAME`,
      {
        headers: {
          "X-Auth-Email": cf_email,
          "X-Auth-Key": cf_api_key,
          "Content-Type": "application/json"
        }
      }
    )
  ).result;

  async function read_body(req) {
    return new Promise((accept, reject) => {
      const chunks = [];
      req.on("data", c => chunks.push(c));
      req.on("end", () => accept(Buffer.concat(chunks)));
      req.on("error", err => reject(err));
    });
  }

  const db = sqlite3("proxies.sqlite3");
  db.exec(
    "CREATE TABLE IF NOT EXISTS proxies (name TEXT PRIMARY KEY, pubkey TEXT)"
  );
  addproxystmt = db.prepare(
    "insert into proxies (name,pubkey) values (?,?)"
  );
  deleteproxystmt = db.prepare("delete from proxies where name = ?");
  updateproxystmt = db.prepare(
    "update proxies set name = ?, pubkey = ? where name = ?"
  );
  getproxiesstmt = db.prepare(
    "select name, pubkey from proxies"
  );

  const server = http.createServer(async (req, res) => {
    console.log(req.method, req.url);
    try {
    if (req.method === "POST") {
      body = await read_body(req);
      q = qs.parse(body.toString("utf-8"));
      const new_proxy = {
        name: q["new.name"],
        pub: q["new.pub"]
      };
      console.log(new_proxy);
      if (
        new_proxy.name.length &&
        new_proxy.pub.length
      ) {
          addproxystmt.run(new_proxy.name, new_proxy.pub);
          await docker_add(new_proxy)
          await add_dns_record(new_proxy.name);
          await add_dns_record(new_proxy.name + '-server');
      }

      for (let e of Object.keys(q)) {
        if (e.indexOf("name.") === 0) {
          name = e.substring("name.".length);
          new_name: q["name." + name];
          pub = q["pub." + name];

          if (q.action === "Update " + name) {
            updateproxystmt.run(new_name, pub, name);
            await docker_remove(name);
            await docker_add({ name: name, pub: pub });
          } else if (q.action === "Remove " + name) {
            deleteproxystmt.run(name);
            await docker_remove(name);
          }
        }
      }
    }
    } catch(e) {
	    console.log(e)
    }

    const template = fs.readFileSync("homepage.mustache", {
      encoding: "utf-8"
    });
    html = mustache.render(template, {
      proxies: getproxiesstmt.all()
    });

    res.write(html);
    res.end();
  });

  async function docker_remove(name) {
    return new Promise((accept, reject) => {
      docker.listContainers(function(err, containers) {
        if (err) return reject(err);
        found = false;
        containers.forEach(function(containerInfo) {
          if (containerInfo.Names[0] === "/proxy_" + name) {
            console.log("remove", containerInfo);
            found = true;
            docker.getContainer(containerInfo.Id).stop((err, data) => {
                if (err) return reject(err);
                remove((err, data) => {
                  if (err) return reject(err);
                  return accept(data);
                });
              })
          }
        });
        if (!found) {
          accept();
        }
      });
    });
  }

  async function docker_add(new_proxy) {
    return new Promise((accept, reject) => {
      docker
        .createContainer({
        name:`${new_proxy.name}_proxy`,
        Image: "tun",
        Labels: {
          "sshgrok.enable":"true",
          "traefik.docker.network":"webproxy",
          "traefik.enable":"true",
          "traefik.proxy_front.frontend.rule":`Host:${new_proxy.name}.averymatt.com`,
          "traefik.proxy_front.port":"3000",
          "traefik.proxy_front.protocol":"http",
          "traefik.proxy_server.frontend.rule":`Host:${new_proxy.name}-server.averymatt.com`,
          "traefik.proxy_server.port":"4022",
          "traefik.proxy_server.protocol":"http"
        },
        Env: [
          `SSH_PUBKEY=${new_proxy.pub}`
        ],
        NetworkingConfig: {
			EndpointsConfig: {
				"webproxy": { }
			}
	}
        })
        .then(function(container) {
          container.start();
          accept()
        });
    });
  }

  server.listen(3000);
}
