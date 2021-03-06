import _ from 'lodash'
import makeConcurrent from 'make-concurrent'
import { autobind } from 'core-decorators'
import bitcore from 'bitcore-lib'
import cclib from 'coloredcoinjs-lib'
import ElapsedTime from 'elapsed-time'

import config from '../lib/config'
import logger from '../lib/logger'
import SQL from '../lib/sql'
import util from '../lib/util'

const cdefClss = cclib.definitions.Manager.getColorDefinitionClasses()

function callWithLock (target, name, descriptor) {
  let fn = descriptor.value
  descriptor.value = async function () {
    return this.withLock(() => fn.apply(this, arguments))
  }
}

/**
 * @class Sync
 */
export default class Sync {
  /**
   * @constructor
   * @param {Storage} storage
   * @param {Messages} messages
   */
  constructor (storage, messages) {
    this.storage = storage
    this.messages = messages
  }

  /**
   * @param {string} txId
   * @return {Promise.<string>}
   */
  @autobind
  async getTx (txId) {
    let {rows} = await this.storage.executeQuery(SQL.select.transactions.byTxId, [`\\x${txId}`])
    if (rows.length === 0) {
      throw new Error(`Tx ${txId} not found!`)
    }

    return bitcore.Transaction(rows[0].tx.toString('hex'))
  }

  /**
   * @param {pg.Client} client
   * @param {string} txId
   * @param {string} [blockhash]
   * @param {number} [height]
   * @return {Promise<boolean>}
   */
  async _addTx (client, txId, blockhash, height) {
    let {rows} = await client.queryAsync(SQL.select.ccScannedTxIds.isTxScanned, [`\\x${txId}`])
    if (rows[0].exists === true) {
      return false
    }

    let tx = await this.getTx(txId)
    let opts = {executeOpts: {client: client}}

    let query = SQL.insert.ccScannedTxIds.unconfirmed
    let params = [`\\x${txId}`]
    if (blockhash !== undefined) {
      query = SQL.insert.ccScannedTxIds.confirmed
      params.push(`\\x${blockhash}`, height)
    }

    await* _.flattenDeep([
      cdefClss.map((cdefCls) => {
        return this._cdata.fullScanTx(tx, cdefCls, this.getTx, opts)
      }),
      client.queryAsync(query, params)
    ])

    return true
  }

  /**
   */
  @makeConcurrent({concurrency: 1})
  withLock (fn) { return fn() }

  /**
   * @param {string[]} txIds
   * @return {Promise}
   */
  @callWithLock
  async addTxs (txIds) {
    for (let txId of txIds) {
      try {
        let stopwatch = ElapsedTime.new().start()

        let added = await this.storage.executeTransaction((client) => {
          return this._addTx(client, txId)
        })

        if (added) {
          logger.verbose(`Add unconfirmed tx ${txId}, elapsed time: ${stopwatch.getValue()}`)
        }
      } catch (err) {
        logger.error(`Error on adding unconfirmed tx ${txId}: ${err.stack}`)
      }
    }
  }

  /**
   * @param {string[]} txIds
   * @return {Promise}
   */
  @callWithLock
  async removeTxs (txIds) {
    for (let txId of txIds) {
      try {
        let stopwatch = ElapsedTime.new().start()

        let removed = await this.storage.executeTransaction(async (client) => {
          let {rows} = await client.queryAsync(SQL.select.ccScannedTxIds.isTxScanned, [`\\x${txId}`])
          if (rows[0].exists === false) {
            return false
          }

          let opts = {executeOpts: {client: client}}

          await* _.flattenDeep([
            cdefClss.map(async (cdefCls) => {
              let params
              switch (cdefCls.getColorCode()) {
                case 'epobc':
                  params = [`epobc:${txId}:\d+:0`]
                  break
                default:
                  throw new Error(`Unknow cdefCls: ${cdefCls}`)
              }

              let {rows} = await client.queryAsync(SQL.select.ccDefinitions.colorId, params)
              if (rows.length !== 0) {
                let id = parseInt(rows[0].id, 10)
                return await this._cdefManager.remove({id: id}, opts)
              }

              await this._cdata.removeColorValues(txId, cdefCls, opts)
            }),
            client.queryAsync(SQL.delete.ccScannedTxIds.byTxId, [`\\x${txId}`])
          ])

          return true
        })

        if (removed) {
          logger.verbose(`Remove tx ${txId}, elapsed time: ${stopwatch.getValue()}`)
        }
      } catch (err) {
        logger.error(`Error on removing tx ${txId}: ${err.stack}`)
      }
    }
  }

  /**
   * @return {Promise}
   */
  @callWithLock
  async updateBlocks () {
    let stopwatch = new ElapsedTime()

    let running = true
    while (running) {
      try {
        await this.storage.executeTransaction(async (client) => {
          let latest = null
          let result = await client.queryAsync(SQL.select.ccScannedTxIds.latestBlock)
          if (result.rows.length > 0) {
            latest = {
              hash: result.rows[0].blockhash.toString('hex'),
              height: result.rows[0].height
            }

            result = await client.queryAsync(SQL.select.blocks.latest)
            if (latest.hash === result.rows[0].hash.toString('hex')) {
              running = false
              return
            }

            let hash = latest.hash
            let height = latest.height
            if (height >= result.rows[0].height) {
              height = result.rows[0].height - 1
              let {rows} = await client.queryAsync(SQL.select.ccScannedTxIds.blockHash, [height])
              hash = rows[0].blockhash.toString('hex')
            }

            while (true) {
              result = await client.queryAsync(SQL.select.blocks.txIdsByHeight, [height + 1])
              let header = bitcore.Block.BlockHeader(result.rows[0].header)
              if (hash === util.encode(header.prevHash)) {
                break
              }

              height -= 1
              let {rows} = await client.queryAsync(SQL.select.ccScannedTxIds.blockHash, [height])
              hash = rows[0].blockhash.toString('hex')
            }

            if (hash !== latest.hash) {
              stopwatch.reset().start()
              await client.queryAsync(
                SQL.update.ccScannedTxIds.makeUnconfirmed, [height])
              logger.warn(`Make reorg to ${height}, elapsed time: ${stopwatch.getValue()}`)
            }
          } else {
            result = await client.queryAsync(SQL.select.blocks.txIdsByHeight, [0])
          }

          stopwatch.reset().start()
          let hash = result.rows[0].hash.toString('hex')
          let height = result.rows[0].height
          let txIds = result.rows[0].txids.toString('hex')
          let toUpdate = await* _.range(txIds.length / 64).map(async (i) => {
            let txId = txIds.slice(i * 64, (i + 1) * 64)
            if (!(await this._addTx(client, txId, hash, height))) {
              return txId
            }
          })

          await client.queryAsync(SQL.update.ccScannedTxIds.makeConfirmed, [
            _.filter(toUpdate).map((txId) => `\\x${txId}`),
            `\\x${hash}`,
            height
          ])
          logger.info(`Import block ${hash}:${height}, elapsed time: ${stopwatch.getValue()}`)
        })
      } catch (err) {
        logger.error(`Update error: ${err.stack}`)
      }
    }

    // update unconfirmed
    while (true) {
      try {
        stopwatch.reset().start()
        let [ccTxIds, txIds] = await* [
          this.storage.executeQuery(SQL.select.ccScannedTxIds.unconfirmed),
          this.storage.executeQuery(SQL.select.transactions.unconfirmed)
        ]

        ccTxIds = ccTxIds.rows.map((row) => row.txid.toString('hex'))
        txIds = txIds.rows.map((row) => row.txid.toString('hex'))

        // remove
        this.removeTxs(_.difference(ccTxIds, txIds))

        // add
        this.addTxs(_.difference(txIds, ccTxIds))

        logger.info(`Unconfirmed updated, elapsed time: ${stopwatch.getValue()}`)

        break
      } catch (err) {
        logger.error(`Update (unconfirmed) error: ${err.stack}`)
      }
    }
  }

  /**
   * @return {Promise}
   */
  async run () {
    this._cdefStorage = new cclib.storage.definitions.PostgreSQL({url: config.get('postgresql.url')})
    this._cdataStorage = new cclib.storage.data.PostgreSQL({url: config.get('postgresql.url')})

    this._cdefManager = new cclib.definitions.Manager(this._cdefStorage, this._cdefStorage)
    this._cdata = new cclib.ColorData(this._cdataStorage, this._cdefManager)

    await* [this._cdefManager.ready, this._cdata.ready]

    // scan all new rows
    await this.updateBlocks()

    // subscribe for tx/block events
    await* [
      this.messages.listen('addtx', (obj) => {
        if (obj.unconfirmed) {
          this.addTxs([obj.txId])
        }
      }),
      this.messages.listen('removetx', (obj) => {
        if (obj.unconfirmed) {
          this.removeTxs([obj.txId])
        }
      }),
      this.messages.listen('addblock', ::this.updateBlocks),
      this.messages.listen('removeblock', ::this.updateBlocks)
    ]

    // confirm that all new data was scanned
    await this.updateBlocks()
  }
}
