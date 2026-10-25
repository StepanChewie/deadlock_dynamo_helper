import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity('app_users_v1')
export class AppUserV1Entity {
  @PrimaryColumn({ type: 'varchar', length: 32 })
  steamId!: string;

  @Column({ type: 'varchar', length: 128, nullable: true })
  playerName?: string | null;

  @Column({ type: 'varchar', length: 128, nullable: true })
  lastClientId?: string | null;

  @Column({ type: 'timestamptz' })
  firstSeenAt!: Date;

  @Column({ type: 'timestamptz' })
  lastSeenAt!: Date;
}
