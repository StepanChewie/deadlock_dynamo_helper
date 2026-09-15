import { Injectable } from '@nestjs/common';
import { OverwolfLiveEventDto } from '@dynamo-lab/shared';

@Injectable()
export class RecentLiveEventsService {
  private readonly limit = 100;
  private readonly recentEvents: OverwolfLiveEventDto[] = [];

  append(events: OverwolfLiveEventDto[]): void {
    if (events.length === 0) {
      return;
    }

    this.recentEvents.push(...events);

    if (this.recentEvents.length > this.limit) {
      this.recentEvents.splice(0, this.recentEvents.length - this.limit);
    }
  }

  getRecent(): OverwolfLiveEventDto[] {
    return [...this.recentEvents];
  }
}
