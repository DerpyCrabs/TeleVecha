export class LocalUpdatePts {
  constructor(
    public pts: number,
    public ptsCount: number,
  ) {}
}

export class LocalUpdateChannelPts {
  constructor(
    public channelId: bigint,
    public pts: number,
    public ptsCount: number,
  ) {}
}

export type UpdatePts = LocalUpdatePts | LocalUpdateChannelPts;
