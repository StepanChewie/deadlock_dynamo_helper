import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import { RecommendationDecisionCandidateEvidenceV8 } from '@deadlock-live-probe/shared';

@Entity('recommendation_decision_candidates_v8')
@Index('idx_recommendation_decision_candidates_v8_decision_action', ['decisionId', 'actionKey'], { unique: true })
export class RecommendationDecisionCandidateV8 {
  @PrimaryGeneratedColumn()
  id!: number;

  @Index('idx_recommendation_decision_candidates_v8_decision_id')
  @Column({ type: 'varchar', length: 128 })
  decisionId!: string;

  @Column({ type: 'varchar', length: 255 })
  actionKey!: string;

  @Column({ type: 'varchar', length: 64 })
  actionType!: string;

  @Column({ type: 'bigint', nullable: true })
  targetItemId?: number;

  @Column({ type: 'bigint', nullable: true })
  sellItemId?: number;

  @Column({ type: 'varchar', length: 128, nullable: true })
  recipeId?: string;

  @Column({ type: 'jsonb', nullable: true })
  consumedItemIds?: number[];

  @Column({ type: 'int' })
  effectiveCostSouls!: number;

  @Column({ type: 'int', nullable: true })
  spendableSoulsAfter?: number;

  @Column({ type: 'jsonb', nullable: true })
  resultingItemIds?: number[];

  @Column({ type: 'boolean' })
  feasible!: boolean;

  @Column({ type: 'jsonb' })
  feasibilityReasons!: string[];

  @Column({ type: 'varchar', length: 16 })
  affordable!: string;

  @Column({ type: 'varchar', length: 16 })
  slotLegal!: string;

  @Column({ type: 'varchar', length: 16 })
  recipeLegal!: string;

  @Column({ type: 'varchar', length: 16 })
  shopLegal!: string;

  @Column({ type: 'varchar', length: 16 })
  rulesetLegal!: string;

  @Column({ type: 'boolean' })
  transactionMechanicsKnown!: boolean;

  @Column({ type: 'jsonb' })
  evidence!: RecommendationDecisionCandidateEvidenceV8;

  @Column({ type: 'double precision', nullable: true })
  behaviorProbability?: number;

  @Column({ type: 'double precision', nullable: true })
  policyScore?: number;

  @Column({ type: 'double precision', nullable: true })
  valueScore?: number;
}
