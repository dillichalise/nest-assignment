import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { decimalTransformer } from '../common/transformers/decimal.transformer';
import { User } from '../users/user.entity';
import { ApplicationStatus } from './enums/application-status.enum';
import { RiskStatus } from './enums/risk-status.enum';

@Entity('merchant_applications')
@Index(['status'])
@Index(['createdById'])
@Index(['assignedReviewerId'])
@Index(['createdAt'])
export class MerchantApplication {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  // Business
  @Column({ type: 'varchar', length: 255 })
  businessName!: string;

  @Column({ type: 'varchar', length: 255 })
  legalBusinessName!: string;

  @Column({ type: 'varchar', length: 100 })
  businessType!: string;

  // Owner / contact
  @Column({ type: 'varchar', length: 255 })
  ownerName!: string;

  @Column({ type: 'varchar', length: 255 })
  ownerEmail!: string;

  @Column({ type: 'varchar', length: 50 })
  ownerPhone!: string;

  @Column({ type: 'text' })
  ownerTaxId!: string;

  // Requested processing
  @Column({
    type: 'numeric',
    precision: 14,
    scale: 2,
    transformer: decimalTransformer,
  })
  monthlyVolume!: string;

  @Column({
    type: 'numeric',
    precision: 12,
    scale: 2,
    transformer: decimalTransformer,
  })
  averageTicketSize!: string;

  /** ISO 4217 code, e.g. USD. */
  @Column({ type: 'char', length: 3 })
  currency!: string;

  // Workflow
  @Column({
    type: 'enum',
    enum: ApplicationStatus,
    enumName: 'application_status',
    default: ApplicationStatus.DRAFT,
  })
  status!: ApplicationStatus;

  @Column({
    type: 'enum',
    enum: RiskStatus,
    enumName: 'risk_status',
    default: RiskStatus.NOT_STARTED,
  })
  riskStatus!: RiskStatus;

  @Column({ type: 'integer', nullable: true })
  riskScore!: number | null;

  @Column({ type: 'jsonb', nullable: true })
  riskResult!: Record<string, unknown> | null;

  // Ownership / assignment
  @Column({ type: 'uuid' })
  createdById!: string;

  @ManyToOne(() => User, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'createdById' })
  createdBy?: User;

  @Column({ type: 'uuid', nullable: true })
  assignedReviewerId!: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'assignedReviewerId' })
  assignedReviewer?: User | null;

  // Decision
  @Column({ type: 'text', nullable: true })
  decisionReason!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  decidedAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  submittedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
