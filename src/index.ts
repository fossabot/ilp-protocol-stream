import { EventEmitter } from 'events'
import * as ILDCP from 'ilp-protocol-ildcp'
import * as IlpPacket from 'ilp-packet'
import * as Debug from 'debug'
import * as cryptoHelper from './crypto'
import { randomBytes } from 'crypto'
import { Connection, ConnectionOpts } from './connection'
import { Plugin } from './util/plugin-interface'
require('source-map-support').install()

const CONNECTION_ID_REGEX = /^[a-zA-Z0-9_-]+$/

export interface CreateConnectionOpts extends ConnectionOpts {
  /** ILP Address of the server */
  destinationAccount: string,
  /** Shared secret generated by the server */
  sharedSecret: Buffer
}

/**
 * Create a [`Connection`]{@link Connection} to a [`Server`]{@link Server} using the `destinationAccount` and `sharedSecret` provided.
 */
export async function createConnection (opts: CreateConnectionOpts): Promise<Connection> {
  const plugin = opts.plugin
  await plugin.connect()
  const debug = Debug('ilp-protocol-stream:Client')
  const sourceAccount = (await ILDCP.fetch(plugin.sendData.bind(plugin))).clientAddress
  const connection = new Connection({
    ...opts,
    sourceAccount,
    isServer: false,
    plugin
  })
  plugin.registerDataHandler(async (data: Buffer): Promise<Buffer> => {
    let prepare: IlpPacket.IlpPrepare
    try {
      prepare = IlpPacket.deserializeIlpPrepare(data)
    } catch (err) {
      debug(`got data that is not an ILP Prepare packet: ${data.toString('hex')}`)
      return IlpPacket.serializeIlpReject({
        code: 'F00',
        message: `Expected an ILP Prepare packet (type 12), but got packet with type: ${data[0]}`,
        data: Buffer.alloc(0),
        triggeredBy: sourceAccount
      })
    }

    try {
      const fulfill = await connection.handlePrepare(prepare)
      return IlpPacket.serializeIlpFulfill(fulfill)
    } catch (err) {
      if (!err.ilpErrorCode) {
        debug('error handling prepare:', err)
      }
      // TODO should the default be F00 or T00?
      return IlpPacket.serializeIlpReject({
        code: err.ilpErrorCode || 'F00',
        message: err.ilpErrorMessage || '',
        data: err.ilpErrorData || Buffer.alloc(0),
        triggeredBy: sourceAccount
      })
    }
  })
  connection.once('close', () => {
    plugin.deregisterDataHandler()
    plugin.disconnect()
      .then(() => debug('plugin disconnected'))
      .catch((err: Error) => debug('error disconnecting plugin:', err))
  })
  await connection.connect()
  // TODO resolve only when it is connected
  return connection
}

export interface ServerOpts extends ConnectionOpts {
  serverSecret?: Buffer
}

/**
 * STREAM Server that can listen on an account and handle multiple incoming [`Connection`s]{@link Connection}.
 * Note: the connections this refers to are over ILP, not over the Internet.
 *
 * The Server operator should give a unique address and secret (generated by calling
 * [`generateAddressAndSecret`]{@link generateAddressAndSecret}) to each client that it expects to connect.
 *
 * The Server will emit a `'connection'` event when the first packet is received for a specific Connection.
 */
export class Server extends EventEmitter {
  protected serverSecret: Buffer
  protected plugin: Plugin
  protected sourceAccount: string
  protected connections: { [key: string]: Connection }
  protected closedConnections: { [key: string]: boolean }
  protected debug: Debug.IDebugger
  protected enablePadding?: boolean
  protected connected: boolean
  protected connectionOpts: ConnectionOpts

  constructor (opts: ServerOpts) {
    super()
    this.serverSecret = opts.serverSecret || randomBytes(32)
    this.plugin = opts.plugin
    this.debug = Debug('ilp-protocol-stream:Server')
    this.connections = {}
    this.closedConnections = {}
    this.connectionOpts = Object.assign({}, opts, {
      serverSecret: undefined
    }) as ConnectionOpts
    this.connected = false
  }

  /**
   * Event fired when a new [`Connection`]{@link Connection} is received
   * @event connection
   * @type {Connection}
   */

  /**
   * Connect the plugin and start listening for incoming connections.
   *
   * When a new connection is accepted, the server will emit the "connection" event.
   *
   * @fires connection
   */
  async listen (): Promise<void> {
    if (this.connected && this.plugin.isConnected()) {
      return
    }
    this.plugin.registerDataHandler(this.handleData.bind(this))
    await this.plugin.connect()
    this.sourceAccount = (await ILDCP.fetch(this.plugin.sendData.bind(this.plugin))).clientAddress
    this.connected = true
  }

  /**
   * End all connections and disconnect the plugin
   */
  async close (): Promise<void> {
    await Promise.all(Object.keys(this.connections).map((id: string) => {
      return this.connections[id].end()
    }))

    this.plugin.deregisterDataHandler()
    await this.plugin.disconnect()
    this.connected = false
  }

  /**
   * Resolves when the next connection is accepted.
   *
   * To handle subsequent connections, the user must call `acceptConnection` again.
   * Alternatively, the user can listen on the `'connection'` event.
   */
  async acceptConnection (): Promise<Connection> {
    await this.listen()
    /* tslint:disable-next-line:no-unnecessary-type-assertion */
    return new Promise((resolve, reject) => {
      this.once('connection', resolve)
    }) as Promise<Connection>
  }

  /**
   * Generate an address and secret for a specific client to enable them to create a connection to the server.
   *
   * Two different clients SHOULD NOT be given the same address and secret.
   *
   * @param connectionTag Optional connection identifier that will be appended to the ILP address and can be used to identify incoming connections. Can only include characters that can go into an ILP Address
   */
  generateAddressAndSecret (connectionTag?: string): { destinationAccount: string, sharedSecret: Buffer } {
    if (!this.connected) {
      throw new Error('Server must be connected to generate address and secret')
    }
    let token = base64url(cryptoHelper.generateToken())
    if (connectionTag) {
      if (!CONNECTION_ID_REGEX.test(connectionTag)) {
        throw new Error('connectionTag can only include ASCII characters a-z, A-Z, 0-9, "_", and "-"')
      }
      token = token + '~' + connectionTag
    }
    const sharedSecret = cryptoHelper.generateSharedSecretFromToken(this.serverSecret, Buffer.from(token, 'ascii'))
    return {
      // TODO should this be called serverAccount or serverAddress instead?
      destinationAccount: `${this.sourceAccount}.${token}`,
      sharedSecret
    }
  }

  /**
   * Parse incoming ILP Prepare packets and pass them to the correct connection
   */
  protected async handleData (data: Buffer): Promise<Buffer> {
    try {
      let prepare: IlpPacket.IlpPrepare
      try {
        prepare = IlpPacket.deserializeIlpPrepare(data)
      } catch (err) {
        this.debug(`got data that is not an ILP Prepare packet: ${data.toString('hex')}`)
        return IlpPacket.serializeIlpReject({
          code: 'F00',
          message: `Expected an ILP Prepare packet (type 12), but got packet with type: ${data[0]}`,
          data: Buffer.alloc(0),
          triggeredBy: this.sourceAccount
        })
      }

      const localAddressParts = prepare.destination.replace(this.sourceAccount + '.', '').split('.')
      if (localAddressParts.length === 0 || !localAddressParts[0]) {
        this.debug(`destination in ILP Prepare packet does not have a Connection ID: ${prepare.destination}`)
        throw new IlpPacket.Errors.UnreachableError('')
      }
      const connectionId = localAddressParts[0]

      if (this.closedConnections[connectionId]) {
        this.debug(`got packet for connection that was already closed: ${connectionId}`)
        throw new IlpPacket.Errors.UnreachableError('')
      }

      if (!this.connections[connectionId]) {
        let sharedSecret
        try {
          const token = Buffer.from(connectionId, 'ascii')
          sharedSecret = cryptoHelper.generateSharedSecretFromToken(this.serverSecret, token)
          cryptoHelper.decrypt(sharedSecret, prepare.data)
        } catch (err) {
          this.debug(`got prepare for an address and token that we did not generate: ${prepare.destination}`)
          throw new IlpPacket.Errors.UnreachableError('')
        }

        // If we get here, that means it was a token + sharedSecret we created
        const connectionTag = (connectionId.indexOf('~') !== -1 ? connectionId.slice(connectionId.indexOf('~') + 1) : undefined)
        const connection = new Connection({
          ...this.connectionOpts,
          sourceAccount: this.sourceAccount,
          sharedSecret,
          isServer: true,
          connectionTag,
          plugin: this.plugin
        })
        this.connections[connectionId] = connection
        this.debug(`got incoming packet for new connection: ${connectionId}${(connectionTag ? ' (connectionTag: ' + connectionTag + ')' : '')}`)
        try {
          this.emit('connection', connection)
        } catch (err) {
          this.debug('error in connection event handler:', err)
        }

        connection.once('close', () => {
          delete this.connections[connectionId]
          this.closedConnections[connectionId] = true
        })

        // Wait for the next tick of the event loop before handling the prepare
        await new Promise((resolve, reject) => setImmediate(resolve))
      }

      const fulfill = await this.connections[connectionId].handlePrepare(prepare)
      return IlpPacket.serializeIlpFulfill(fulfill)

    } catch (err) {
      if (!err.ilpErrorCode) {
        this.debug('error handling prepare:', err)
      }
      // TODO should the default be F00 or T00?
      return IlpPacket.serializeIlpReject({
        code: err.ilpErrorCode || 'F00',
        message: err.ilpErrorMessage || '',
        data: err.ilpErrorData || Buffer.alloc(0),
        triggeredBy: this.sourceAccount || ''
      })
    }
  }
}

/**
 * Creates a [`Server`]{@link Server} and resolves when the server is connected and listening
 */
export async function createServer (opts: ServerOpts): Promise<Server> {
  const server = new Server(opts)
  await server.listen()
  return server
}

function base64url (buffer: Buffer) {
  return buffer.toString('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
}
