const Promise = require('bluebird'),
  semaphore = require('semaphore'),
  states = require('../factories/stateFactory'),
  messageTypes = require('../factories/messageTypesFactory'),
  Web3 = require('web3'),
  web3 = new Web3(),
  _ = require('lodash'),
  eventTypes = require('../factories/eventTypesFactory'),
  eventEmitter = require('events');

class TaskProcessor extends eventEmitter {

  constructor (mokka) {
    super();
    this.semPending = semaphore(1);
    this.sem = semaphore(1);
    this.mokka = mokka;
    this.run = 1;

  }

  async push (task) {
    return await new Promise(res =>
      this.semPending.take(async () => {
        await this.mokka.log.putPending(task);
        //await this.mokka.gossip.push(task);//todo implement

        this.semPending.leave();
        res();
      })
    );
  }

  async claimLeadership () {
    if (this.mokka.state !== states.LEADER)
      await this._lock();
  }

  async _runLoop () { //loop for checking new packets
    while (this.run) {


      if (!this.sem.available()) {
        await new Promise(res => this.once(eventTypes.QUEUE_AVAILABLE, res));
        continue;
      }

      let lastEntry = await this.mokka.log.getLastEntry();

      if (this.mokka.state === states.LEADER && lastEntry.index > 0 && lastEntry.owner === this.mokka.publicKey) {//check for leader only

        let followers = _.chain(this.mokka.nodes)
          .reject(node => _.find(lastEntry.responses, {publicKey: node.publicKey}))
          .value();

        const minConfirmations = Math.floor(followers.length / 2) + 1;

        if (lastEntry.responses.length - 1 < minConfirmations) {
          await new Promise(res => this.mokka.once(eventTypes.ENTRY_COMMITTED, res));
          continue;
        }
      }


      let pending = await this.mokka.log.getFirstPending();
      if (!pending.hash) {
        await Promise.delay(this.mokka.time.timeout()); //todo delay for next tick or event on new push
        continue;
      }


      await this._commit(pending.command, pending.hash);
    }
  }

  async _commit (task, hash) {

    return await new Promise(res =>
      this.sem.take(async () => {

        let checkPending = await this.mokka.log.getPending(hash);

        if (!checkPending) {
          this.sem.leave();
          this.emit(eventTypes.QUEUE_AVAILABLE);
          return res();
        }

        if (this.mokka.state === states.LEADER) {
          let entry = await this._save(task);
          await this._broadcast(entry.index, entry.hash);
          this.mokka.logger.trace(`task has been broadcasted ${task}`);
          this.mokka.logger.trace(`pulling pending task ${task} with hash ${hash}`);//todo think about pull
          await this.mokka.log.pullPending(hash);
        } else {
          await this._broadcastPending(task, hash);

          await this.mokka.log.pullPending(hash);//todo pull task when leader received it (may be make ack_pending?)
        }


        this.sem.leave();
        this.emit(eventTypes.QUEUE_AVAILABLE);
        res();
      })
    );
  }

  async _lock () {

    const {index, createdAt} = await this.mokka.log.getLastEntry();

    if (Date.now() - createdAt < this.mokka.election.max && index !== 0) {
      this.mokka.time.heartbeat(this.mokka.election.max);
      await Promise.delay(this.mokka.election.max - (Date.now() - createdAt));
      this.mokka.logger.trace('going to await for the current leader');
      return await this._lock();
    }


    this.mokka.logger.trace('promoting by propose');
    this.mokka.time.timers.clear('heartbeat');
    await this.mokka.actions.node.promote(2);

    this.mokka.time.heartbeat(this.mokka.time.timeout() + this.mokka.election.max);

    await Promise.delay(this.mokka.election.max);

    if (this.mokka.state !== states.LEADER) {
      this.mokka.logger.trace('trying to propose task again');
      let timeout = this.mokka.time.timeout();
      const {createdAt} = this.mokka.lastInfo;
      const delta = Date.now() - createdAt;

      if (delta < this.mokka.election.max)
        timeout += delta;

      this.mokka.time.heartbeat(timeout);
      await Promise.delay(timeout);
      return await this._lock();
    }

  }

  async _save (task) {

    const command = {task: task};

    const {signature} = web3.eth.accounts.sign(JSON.stringify(command), `0x${this.mokka.privateKey}`);
    return await this.mokka.log.saveCommand(command, this.mokka.term, signature);
  }

  async _broadcast (index, hash) {

    let entry = await this.mokka.log.get(index);

    if (!entry || entry.hash !== hash)
      return this.mokka.logger.trace(`can't broadcast entry at index ${index}`);

    this.mokka.logger.trace(`broadcasting task ${entry.command.task} at index ${index}`);

    if (entry.term !== this.mokka.term || this.mokka.state !== states.LEADER)
      return entry;

    let followers = _.chain(this.mokka.nodes)
      .reject(node => _.find(entry.responses, {publicKey: node.publicKey}))
      .value();

    if (followers.length === 0)
      return entry;

    const appendPacket = await this.mokka.actions.message.appendPacket(entry);
    let pubKeys = followers.map(node => node.publicKey);

    await this.mokka.actions.message.message(pubKeys, appendPacket);

  }

  async _broadcastPending (task, hash) {

    if (!this.mokka.leader) {
      await new Promise(res => this.mokka.once(eventTypes.LEADER, res));
      return await this._broadcastPending(task, hash);
    }

    let entry = await this.mokka.log.getPending(hash);

    if (!entry || entry.received)
      return;


    const proposePacket = await this.mokka.actions.message.packet(messageTypes.PROPOSE, task);//todo add validation by signature
    await this.mokka.actions.message.message(states.LEADER, proposePacket);

    //todo make event about received append_pending task
    return await new Promise(res =>
      this.mokka.once(eventTypes.PENDING_COMMITTED, (hash) => {
          if (hash === entry.hash)
            res();
        }
      ))
      .timeout(this.mokka.time.timeout())
      .catch(async () => await this._broadcastPending(task, hash));


  }


}

module.exports = TaskProcessor;
