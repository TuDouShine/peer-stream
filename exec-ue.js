signalIp = '127.0.0.1'
signalPort = 88

const protocol = 'exec-ue'

const WebSocket = require('ws')

function ConnectWsServer() {
  // 创建 WebSocket 客户端并连接到服务器
  console.log(`ConnectWsServer signalIp=${signalIp} signalPort=${signalPort}`)

  const client = new WebSocket(`ws://${signalIp}:${signalPort}`, protocol)
  // 监听连接错误事件
  client.on('error', () => {
    console.log(
      `WebSocket client error signalIp=${signalIp} signalPort=${signalPort}`
    )
    client.close()
  })

  // 监听连接关闭事件
  client.on('close', () => {
    console.log(
      `WebSocket client close signalIp=${signalIp} signalPort=${signalPort}`
    )
    client.close()
  })

  // 监听连接成功事件
  client.on('open', () => {
    console.log(
      `WebSocket client open signalIp=${signalIp} signalPort=${signalPort}`
    )
  })

  // 监听消息事件
  client.on('message', (message) => {
    console.log(`Received message: ${message}`)
    if (message instanceof Buffer) {
      message = message.toString('utf8')
    }
    if (message instanceof ArrayBuffer) {
      message = Buffer.from(message).toString('utf8')
    }
    require('child_process').exec(
      message,
      { cwd: __dirname, encoding: 'buffer' },
      (error, stdout, stderr) => {
        if (error) {
          // Windows 中文控制台默认 GBK(cp936)，按 UTF-8 解析会乱码
          const enc = process.platform === 'win32' ? 'gbk' : 'utf8'
          let detail = ''
          try {
            detail = new TextDecoder(enc).decode(stderr || Buffer.alloc(0)).trim()
          } catch {
            detail = String(stderr || '')
          }
          console.error(`exec error: ${message}\n${detail || error.message}`)
          return
        }
      }
    )
  })
  client.on('pong', heartbeat)
  return client
}

function heartbeat() {
  this.isAlive = true
}

let wsClient = ConnectWsServer()
wsClient.isAlive = true

const interval = setInterval(() => {
  if (wsClient.readyState == WebSocket.CONNECTING) {
    return
  }
  if (wsClient.readyState == WebSocket.OPEN) {
    if (false == wsClient.isAlive) {
      wsClient.terminate()
      return
    }
    wsClient.isAlive = false
    wsClient.ping('', true)
  }
  if (wsClient.readyState == WebSocket.CLOSED) {
    wsClient.close()

    wsClient = ConnectWsServer()
    wsClient.isAlive = true
  }
}, 10 * 1000)
