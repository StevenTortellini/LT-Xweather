require("dotenv").config();

const axios = require("axios");

const clientId = process.env.XWEATHER_CLIENT_ID;
const clientSecret = process.env.XWEATHER_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error("Missing XWEATHER_CLIENT_ID or XWEATHER_CLIENT_SECRET.");
  process.exit(1);
}

axios.get(
  `https://data.api.xweather.com/lightning/${encodeURIComponent(process.env.XWEATHER_LOCATION || "hopkinsville,ky")}`,
  {
    params: {
      client_id: clientId,
      client_secret: clientSecret,
      radius: process.env.XWEATHER_RADIUS || "10mi",
      limit: process.env.XWEATHER_LIMIT || 100
    }
  }
)
.then(response => {
  console.log(JSON.stringify(response.data, null, 2));
})
.catch(error => {
  console.log(error.response?.data || error.message);
});
