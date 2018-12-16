const messageTypes = require('../factories/messageTypesFactory'),
  Web3 = require('web3'),
  states = require('../factories/stateFactory'),
  secrets = require('secrets.js-grempe'),
  _ = require('lodash'),
  bunyan = require('bunyan'),
  restorePubKey = require('../../utils/restorePubKey'),
  calculateVoteDelay = require('../../utils/calculateVoteDelay'),
  log = bunyan.createLogger({name: 'node.actions.vote'}),
  web3 = new Web3();


const vote = async function (packet) {


  let blackListed = this.cache.get(`blacklist.${packet.publicKey}`);

  if (blackListed && (blackListed.term < packet.term || blackListed.hash !== packet.last.hash))
    this.cache.del(`blacklist.${packet.publicKey}`);

  const {index, hash, createdAt} = await this.log.getLastInfo();
  const currentTerm = this.state === states.CANDIDATE ? this.term - 1 : this.term;

  if (!packet.data.share) {

    this.cache.set(`blacklist.${packet.publicKey}`, {term: packet.term, hash: packet.last.hash}, Infinity);

    this.emit(messageTypes.VOTE, packet, false);
    let reply = await this.actions.message.packet(messageTypes.VOTED, {
      granted: false,
      signature: null,
      reason: 'share is not provided'
    });

    return {
      reply: reply,
      who: packet.publicKey
    };
  }

  const {signature} = web3.eth.accounts.sign(packet.data.share, `0x${this.privateKey}`);


  if (blackListed) {
    this.emit(messageTypes.VOTE, packet, false);
    let reply = await this.actions.message.packet(messageTypes.VOTED, {
      granted: false,
      signature: signature,
      share: packet.data.share,
      reason: 'blacklisted until next term'
    });

    return {
      reply: reply,
      who: packet.publicKey
    };
  }


  if (packet.last.index !== 0 && Date.now() - createdAt < this.beat) {
    this.emit(messageTypes.VOTE, packet, false);

    this.cache.set(`blacklist.${packet.publicKey}`, {term: packet.term, hash: packet.last.hash}, Infinity);

    let reply = await this.actions.message.packet(messageTypes.VOTED, {
      granted: false,
      signature: signature,
      share: packet.data.share,
      reason: 'the voting window hasn\'t been closed yet',
      code: 0
    });

    return {
      reply: reply,
      who: packet.publicKey
    };
  }

  if (packet.last.index !== 0 && Date.now() - createdAt < this.election.max) {
    this.emit(messageTypes.VOTE, packet, false);

    this.cache.set(`blacklist.${packet.publicKey}`, {term: packet.term, hash: packet.last.hash}, Infinity);

    let reply = await this.actions.message.packet(messageTypes.VOTED, {
      granted: false,
      signature: signature,
      share: packet.data.share,
      reason: 'it seems that master is still committing',
      code: 1
    });
    return {
      reply: reply,
      who: packet.publicKey
    };
  }

  if (currentTerm > packet.term) { //in case the candidate is outdated by term
    this.emit(messageTypes.VOTE, packet, false);

    this.cache.set(`blacklist.${packet.publicKey}`, {term: packet.term, hash: packet.last.hash}, Infinity);

    let reply = await this.actions.message.packet(messageTypes.VOTED, {
      granted: false,
      signature: signature,
      share: packet.data.share,
      reason: 'the candidate is outdated (by term)',
      code: 3
    });
    return {
      reply: reply,
      who: packet.publicKey
    };
  }

  if (index > packet.last.index) {
    let log = await this.log.get(packet.last.index);

    if (log && log.hash === packet.last.hash) {

      this.emit(messageTypes.VOTE, packet, false);

      this.cache.set(`blacklist.${packet.publicKey}`, {term: packet.term, hash: packet.last.hash}, this.election.max);

      let reply = await this.actions.message.packet(messageTypes.VOTED, {
        granted: false,
        signature: signature,
        share: packet.data.share,
        reason: 'the candidate is outdated (by history)',
        code: 3
      });
      return {
        reply: reply,
        who: packet.publicKey
      };


    }
  }


  if (index === packet.last.index && hash !== packet.last.hash) {

    this.emit(messageTypes.VOTE, packet, false);

    this.cache.set(`blacklist.${packet.publicKey}`, {term: packet.term, hash: packet.last.hash}, this.election.max);

    let reply = await this.actions.message.packet(messageTypes.VOTED, {
      granted: false,
      signature: signature,
      share: packet.data.share,
      reason: 'the candidate has wrong history',
      code: 3
    });
    return {
      reply: reply,
      who: packet.publicKey
    };

  }


  /*
    if(packet.last.index > index){//todo check condition

      console.log('super22')
      console.log(require('util').inspect(packet, null, 10));
      process.exit(0);


    }
  */


  if (this.votes.for && (this.votes.started && Date.now() - this.votes.started < this.election.max)) {

    log.info(`current voting: ${this.votes.for}`);

    let ttl = await calculateVoteDelay(currentTerm, packet.publicKey, this);
    log.info(`blacklisting ${packet.publicKey} for ${ttl} under term: ${packet.term}`);
    if (ttl)
      this.cache.set(`blacklist.${packet.publicKey}`, {term: packet.term, hash: packet.last.hash}, ttl);


    let reply = await this.actions.message.packet(messageTypes.VOTED, {
      granted: false,
      signature: signature,
      share: packet.data.share,
      reason: 'already voted for another candidate',
      code: 2
    });
    return {
      reply: reply,
      who: packet.publicKey
    };
  }

  this.votes.for = packet.publicKey;
  this.votes.started = Date.now();
  this.votes.priority = packet.data.priority || 1;
  this.votes.share = packet.data.share;

  if (blackListed)
    this.cache.del(`blacklist.${packet.publicKey}`);

  if (packet.last.index > index) {
    this.emit(messageTypes.VOTE, packet, true);
    let reply = await this.actions.message.packet(messageTypes.VOTED, {
      granted: true, signature: signature,
      share: packet.data.share
    });
    return {
      reply: reply,
      who: packet.publicKey
    };
  }

  if (packet.last.index === index && packet.last.hash !== hash) {
    this.emit(messageTypes.VOTE, packet, true);
    let reply = await this.actions.message.packet(messageTypes.VOTED, {
      granted: true, signature: signature,
      share: packet.data.share
    });
    return {
      reply: reply,
      who: packet.publicKey
    };
  }


  this.emit(messageTypes.VOTE, packet, true);
  this.heartbeat(this.timeout());
  let reply = await this.actions.message.packet(messageTypes.VOTED, {
    granted: true, signature: signature,
    share: packet.data.share
  });
  return {
    reply: reply,
    who: packet.publicKey
  };
};

const voted = async function (packet) {


  log.info(`received new vote for term[${this.term}] with reason: ${packet.data.reason} from peer: ${packet.publicKey}`);

  if (states.CANDIDATE !== this.state) {
    log.info('no longer a candidate');
    let reply = await this.actions.message.packet(messageTypes.ERROR, 'No longer a candidate, ignoring vote');
    return {
      reply: reply,
      who: packet.publicKey
    };
  }

  if (!packet.data.signature) {
    let reply = await this.actions.message.packet(messageTypes.ERROR, 'the vote hasn\'t been singed, ignoring vote');
    return {
      reply: reply,
      who: packet.publicKey
    };
  }

  const restoredPublicKey = restorePubKey(packet.data.share, packet.data.signature);

  let localShare = _.find(this.votes.shares, {
    publicKey: restoredPublicKey,
    share: packet.data.share,
    voted: false
  });

  if (!localShare) {
    log.info(`the share hasnt't been found on term [${this.term}]`);
    let reply = await this.actions.message.packet(messageTypes.ERROR, 'wrong share for vote provided!');
    return {
      reply: reply,
      who: packet.publicKey
    };
  }

  if (localShare.voted) {
    log.info(`you have already voted for me on term [${this.term}]`);
    let reply = await this.actions.message.packet(messageTypes.ERROR, 'already voted for this candidate!');
    return {
      reply: reply,
      who: packet.publicKey
    };
  }

  localShare.voted = true;
  localShare.granted = packet.data.granted;
  localShare.leader = packet.leader;
  localShare.last = packet.last;
  localShare.signature = packet.data.signature;
  localShare.share = packet.data.share;
  localShare.code = packet.data.code;
  localShare.reason = packet.data.reason;

  if (!packet.data.granted)
    log.error(`vote fail due to reason: ${packet.data.reason}`);

  let votedAmount = _.chain(this.votes.shares).filter({voted: true}).size().value();

  log.info(`collected votes: ${votedAmount}`);

  if (!this.quorum(votedAmount))
    return;

  let badVotes = _.filter(this.votes.shares, {granted: false});

  if (badVotes.length >= Math.ceil(votedAmount / 2) + 1) {

    this.votes = {
      for: null,
      granted: 0,
      shares: [],
      secret: null
    };

    let dominatedReason = _.chain(badVotes)
      .transform((result, vote) => {
        result[vote.code] = (result[vote.code] || 0) + 1;
      }, {})
      .toPairs()
      .sortBy(item => item[1])
      .last()
      .nth(0)
      .value();

    log.error(`vote result error: ${dominatedReason}`);

    let reply = await this.actions.message.packet(messageTypes.ACK);


    //if (packet.data.code === 2) {
    if (packet.data.code === 2 || packet.data.code === 1) {
      const currentTerm = this.state === states.CANDIDATE ? this.term - 1 : this.term;
      const ttl = packet.data.code === 2 ? await calculateVoteDelay(currentTerm, this.publicKey, this) : this.election.max;
      log.info(`estimated ttl: ${ttl}`);
      this.cache.set(`blacklist.${this.publicKey}`, {term: this.term - 1, hash: packet.last.hash}, ttl);
    }


    if (this.state === states.CANDIDATE) {

      this.change({term: this.term - 1, state: states.FOLLOWER});
      if (this.timers.active('term_change'))
        this.timers.clear('term_change');


      log.info('clean up passed voting');
      this.votes.for = null;
      this.votes.granted = 0;
      this.votes.shares = [];
      this.votes.secret = null;
      this.votes.started = null;
    }

    return {
      reply: reply,
      who: packet.publicKey
    };
  }


  let validatedShares = this.votes.shares.map(share => share.share);

  let comb = secrets.combine(validatedShares);

  if (comb !== this.votes.secret) {
    this.votes = {
      for: null,
      granted: 0,
      shares: [],
      secret: null
    };

    let reply = await this.actions.message.packet(messageTypes.ACK);
    return {
      reply: reply,
      who: packet.publicKey
    };
  }

  this.change({leader: this.publicKey, state: states.LEADER});

  const compacted = _.chain(this.votes.shares).compact().filter(vote=>vote.signature).reduce((result, item) => {

    console.log(item)

    return `${result}${item.share}${item.signature.replace('0x', '')}`;
  }, '').thru(item => `${item}${this.votes.started}`).value();

  await this.log.addProof(this.term, {
    index: -1,
    hash: null,
    proof: compacted
  });

  let reply = await this.actions.message.appendPacket();

  return {
    reply: reply,
    who: states.FOLLOWER
  };


};

module.exports = (instance) => {

  _.set(instance, 'actions.vote', {
    vote: vote.bind(instance),
    voted: voted.bind(instance)
  });

};
