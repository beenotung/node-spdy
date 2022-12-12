import spdy from 'spdy-fixes'
import { print } from 'listening-on'
import { readFileSync } from 'fs'

let server = spdy.createServer(
  {
    key: readFileSync('localhost-key.pem'),
    cert: readFileSync('localhost.pem'),
    spdy: {},
  },
  (req, res) => {
    console.log(req.method, req.url)
    res.end('ok')
  },
)

let port = 3000
server.listen(port, () => {
  print({ port, protocol: 'https' })
})
