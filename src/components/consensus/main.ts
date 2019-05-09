import random from 'lodash/random';
import {GossipController} from '../gossip/main';
import {MokkaStorage} from '../storage/main';
import {LogApi} from './api/LogApi';
import {NodeApi} from './api/NodeApi';
import messageTypes from './constants/MessageTypes';
import {TimerController} from './controllers/TimerController';
import {ILoggerInterface} from './interfaces/ILoggerInterface';
import {ISettingsInterface} from './interfaces/ISettingsInterface';
import {NodeModel} from './models/NodeModel';
import {VoteModel} from './models/VoteModel';
import {GossipRequestProcessorService} from './services/GossipRequestProcessorService';
import {RequestProcessorService} from './services/RequestProcessorService';
import decodePacket from './utils/decodePacket';

class Mokka extends NodeModel {

  public election: { min: number, max: number };
  public heartbeat: number;
  public gossip: GossipController;
  public logger: ILoggerInterface;
  public vote: VoteModel = new VoteModel();
  public timer: TimerController;
  public logApi: LogApi;
  public nodeApi: NodeApi;
  private db: MokkaStorage;
  private gossipRequestProcessorService: GossipRequestProcessorService;
  private requestProcessorService: RequestProcessorService;

  constructor(options: ISettingsInterface) {
    super(options.privateKey, options.address);

    this.election = {
      max: options.electionMax || 300,
      min: options.electionMin || 150
    };

    this.heartbeat = options.heartbeat || 50;
    this.logger = options.logger || {
      // tslint:disable-next-line
      error: console.log,
      // tslint:disable-next-line
      info: console.log,
      // tslint:disable-next-line
      trace: console.log
    };

    this.timer = new TimerController(this);

    this.gossip = new GossipController(this, options.gossipHeartbeat);

    this.gossipRequestProcessorService = new GossipRequestProcessorService(this);
    this.requestProcessorService = new RequestProcessorService(this);

    this.db = new MokkaStorage(options.storage);

    this.logApi = new LogApi(this);
    this.nodeApi = new NodeApi(this);

    this._registerEvents();
  }

  public getDb(): MokkaStorage {
    return this.db;
  }

  public quorum(responses: number) {
    if (!this.nodes.length || !responses) return false;

    return responses >= this.majority();
  }

  public majority() {
    return Math.ceil(this.nodes.length / 2) + 1;
  }

  public setVote(vote: VoteModel): void {
    this.vote = vote;
  }

  public connect(): void {
    this.gossip.start();
    this.logApi.runLoop();
    this.timer.heartbeat(random(0, this.election.max));
  }

  public async disconnect(): Promise<void> {
    this.timer.clearVoteTimeout();
    this.timer.clearHeartbeatTimeout();
    this.gossip.stop();
    this.logApi.stop();
    await this.getDb().end();
  }

  private _registerEvents() {
    this.on('data', async (packet) => {

      packet = decodePacket(packet);

      if ([
        messageTypes.GOSSIP_SECOND_RESPONSE,
        messageTypes.GOSSIP_FIRST_RESPONSE,
        messageTypes.GOSSIP_REQUEST
      ].includes(packet.type))
        return await this.gossipRequestProcessorService.process(packet);

      await this.requestProcessorService.process(packet);
    });
  }

}

export {Mokka};
