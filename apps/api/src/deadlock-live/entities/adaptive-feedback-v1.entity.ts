import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Post-match usefulness votes.
 *
 * This is a **product signal only**. Per ADR-007 it must never be joined into
 * the recommendation pipeline or used as a training corpus. The table also
 * deliberately stores no player identifier — only the match the vote is about —
 * so a stored row cannot be traced back to an account.
 */
@Entity('adaptive_feedback_v1')
export class AdaptiveFeedbackV1Entity {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Column({ type: 'varchar', length: 32 })
  appVersion!: string;

  @Index('idx_adaptive_feedback_match_v1')
  @Column({ type: 'varchar', length: 128 })
  matchId!: string;

  @Column({ type: 'boolean' })
  useful!: boolean;

  @Column({ type: 'varchar', length: 64, nullable: true })
  reason!: string | null;

  @Column({ type: 'varchar', length: 128, nullable: true })
  requestId!: string | null;

  @CreateDateColumn()
  createdAt!: Date;
}
