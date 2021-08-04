class PacketModel {

  public state: number;
  public term: number;
  public publicKey: string;
  public type: number;
  public data: any;
  public proof: string;
  public timestamp: number;
  public signature: string;

  constructor(
    type: number,
    state: number,
    term: number,
    publicKey: string,
    proof: string,
    data: any = null
    ) {
    this.state = state;
    this.type = type;
    this.term = term;
    this.publicKey = publicKey;
    this.data = data;
    this.proof = proof;
    this.timestamp = Date.now();
  }

}

export { PacketModel };
