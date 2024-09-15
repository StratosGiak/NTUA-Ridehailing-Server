### Prerequisites

1. A running nginx server
1. A running MySQL server
1. Node.js (>=21.7.3) installed along with npm
1. Python >=3.9

### Initialization

1. Configure the values in `src/config/.env.example` appropriately and then rename the file to `.env`
1. Configure `src/confic/example.conf` and move the file to the `conf.d` folder in the nginx directory. Restart the nginx service
1. Install [Certbot](https://certbot.eff.org/) to enable HTTPS via Let's Encrypt
1. Run `./init`
1. Run `npm ci` in the project root

### Running

To start the server, simply run `./run` with the appropriate environment option (-development or -production)
