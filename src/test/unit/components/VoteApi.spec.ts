import Promise from 'bluebird';
import bunyan from 'bunyan';
import {expect} from 'chai';
import crypto from 'crypto';
import {MessageApi} from '../../../consensus/api/MessageApi';
import {VoteApi} from '../../../consensus/api/VoteApi';
import MessageTypes from '../../../consensus/constants/MessageTypes';
import NodeStates from '../../../consensus/constants/NodeStates';
import {Mokka} from '../../../consensus/main';
import TCPMokka from '../../../implementation/TCP';

describe('VoteApi tests', (ctx = {}) => {

  beforeEach(async () => {

    ctx.keys = [];

    ctx.nodes = [];

    for (let i = 0; i < 3; i++) {
      const node = crypto.createECDH('secp256k1');
      node.generateKeys();
      ctx.keys.push({
        privateKey: node.getPrivateKey().toString('hex'),
        publicKey: node.getPublicKey('hex', 'compressed')
      });
    }

    for (let index = 0; index < 3; index++) {
      const instance = new TCPMokka({
        address: `tcp://127.0.0.1:2000/${ctx.keys[index].publicKey}`,
        electionTimeout: 300,
        heartbeat: 50,
        logger: bunyan.createLogger({name: 'mokka.logger', level: 60}),
        privateKey: ctx.keys[index].privateKey,
        proofExpiration: 5000
      });

      for (let i = 0; i < 3; i++)
        if (i !== index)
          instance.nodeApi.join(`tcp://127.0.0.1:${2000 + i}/${ctx.keys[i].publicKey}`);

      ctx.nodes.push(instance);
    }

  });

  it('should check vote', async () => {

    const candidateNode = ctx.nodes[0] as Mokka;
    const followerNode = ctx.nodes[1] as Mokka;

    candidateNode.setState(NodeStates.CANDIDATE, 2, '');

    const packet = await candidateNode.messageApi.packet(MessageTypes.VOTE, {
      nonce: Date.now()
    });

    const start = Date.now();
    // @ts-ignore
    const result = await followerNode.requestProcessorService.voteApi.vote(packet);
    expect(Date.now() - start).to.be.lt(followerNode.heartbeatCtrl.safeHeartbeat() + 30);
    // tslint:disable-next-line:no-unused-expression
    expect(result.data.signature).to.not.be.undefined;

  });

  afterEach(async () => {
    await Promise.delay(1000);
  });

});
