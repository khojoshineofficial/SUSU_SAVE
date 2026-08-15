'use strict';

const ROLES = {
  /** Platform owner: everything, including settings and maintenance mode. */
  SUPER_ADMIN: 'super_admin',
  /** Platform staff: payment analysis, approving withdrawals, audit records. */
  ADMIN: 'admin',
  /** Runs one organization (tenant). */
  ORG_ADMIN: 'org_admin',
  USER: 'user',
};

/** Roles that may reach the platform console at /admin. */
const STAFF_ROLES = [ROLES.SUPER_ADMIN, ROLES.ADMIN];

const ACCOUNT_STATUS = {
  PENDING_PAYMENT: 'pending_payment',
  PENDING_VERIFICATION: 'pending_verification',
  ACTIVE: 'active',
  SUSPENDED: 'suspended',
  INACTIVE: 'inactive',
};

const ORG_STATUS = {
  PENDING: 'pending',
  ACTIVE: 'active',
  SUSPENDED: 'suspended',
  INACTIVE: 'inactive',
};

const GROUP_STATUS = {
  DRAFT: 'draft',
  RECRUITING: 'recruiting',
  ACTIVE: 'active',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
};

const GROUP_MEMBER_STATUS = {
  PENDING: 'pending',
  ACTIVE: 'active',
  REJECTED: 'rejected',
  REMOVED: 'removed',
  EXITED: 'exited',
};

const GROUP_ROLE = {
  ORGANIZER: 'organizer',
  MEMBER: 'member',
};

const FREQUENCY = {
  DAILY: 'daily',
  WEEKLY: 'weekly',
  BIWEEKLY: 'biweekly',
  MONTHLY: 'monthly',
};

const GROUP_FREQUENCIES = [FREQUENCY.DAILY, FREQUENCY.WEEKLY];
const SAVINGS_FREQUENCIES = [FREQUENCY.DAILY, FREQUENCY.WEEKLY, FREQUENCY.BIWEEKLY, FREQUENCY.MONTHLY];

const CONTRIBUTION_STATUS = {
  PENDING: 'pending',
  PAID: 'paid',
  PARTIAL: 'partial',
  LATE: 'late',
  MISSED: 'missed',
};

const PAYOUT_STATUS = {
  SCHEDULED: 'scheduled',
  READY: 'ready',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  FAILED: 'failed',
  ON_HOLD: 'on_hold',
};

const TRANSACTION_TYPE = {
  CONTRIBUTION: 'contribution',
  PAYOUT: 'payout',
  WITHDRAWAL: 'withdrawal',
  DEPOSIT: 'deposit',
  REGISTRATION_FEE: 'registration_fee',
  PLATFORM_FEE: 'platform_fee',
  SAVINGS_FEE: 'savings_fee',
  WITHDRAWAL_FEE: 'withdrawal_fee',
  GROUP_CREATION_FEE: 'group_creation_fee',
  SUBSCRIPTION: 'subscription',
  REFUND: 'refund',
  ADJUSTMENT: 'adjustment',
};

/** Types that increase the wallet balance. Everything else decreases it. */
const CREDIT_TYPES = [
  TRANSACTION_TYPE.DEPOSIT,
  TRANSACTION_TYPE.PAYOUT,
  TRANSACTION_TYPE.REFUND,
];

const TRANSACTION_STATUS = {
  PENDING: 'pending',
  PROCESSING: 'processing',
  SUCCESSFUL: 'successful',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  REFUNDED: 'refunded',
};

const PAYMENT_METHOD = {
  WALLET: 'wallet',
  MOBILE_MONEY: 'mobile_money',
  CARD: 'card',
  BANK: 'bank',
  CASH: 'cash',
  SYSTEM: 'system',
};

const MOMO_PROVIDERS = ['mtn', 'telecel', 'airteltigo'];

const WITHDRAWAL_STATUS = {
  PENDING: 'pending',
  APPROVED: 'approved',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  REJECTED: 'rejected',
  FAILED: 'failed',
};

const SAVINGS_TYPE = {
  PERSONAL: 'personal',
  EMERGENCY: 'emergency',
  RENT: 'rent',
  SCHOOL: 'school',
  BUSINESS: 'business',
  TRAVEL: 'travel',
  GOAL: 'goal',
  CUSTOM: 'custom',
};

const SAVINGS_STATUS = {
  ACTIVE: 'active',
  MATURED: 'matured',
  COMPLETED: 'completed',
  CLOSED: 'closed',
};

const NOTIFICATION_TYPE = {
  CONTRIBUTION_DUE: 'contribution_due',
  CONTRIBUTION_SUCCESSFUL: 'contribution_successful',
  CONTRIBUTION_MISSED: 'contribution_missed',
  GROUP_INVITATION: 'group_invitation',
  GROUP_JOIN_REQUEST: 'group_join_request',
  GROUP_MEMBER_APPROVED: 'group_member_approved',
  PAYOUT_UPCOMING: 'payout_upcoming',
  PAYOUT_COMPLETED: 'payout_completed',
  WITHDRAWAL_REQUESTED: 'withdrawal_requested',
  WITHDRAWAL_COMPLETED: 'withdrawal_completed',
  WITHDRAWAL_FAILED: 'withdrawal_failed',
  SAVINGS_MILESTONE: 'savings_milestone',
  REGISTRATION_PAYMENT: 'registration_payment',
  PLATFORM_FEE: 'platform_fee',
  ANNOUNCEMENT: 'announcement',
};

const SUPPORT_STATUS = {
  OPEN: 'open',
  IN_PROGRESS: 'in_progress',
  RESOLVED: 'resolved',
  CLOSED: 'closed',
};

const values = (obj) => Object.values(obj);

module.exports = {
  ROLES,
  STAFF_ROLES,
  ACCOUNT_STATUS,
  ORG_STATUS,
  GROUP_STATUS,
  GROUP_MEMBER_STATUS,
  GROUP_ROLE,
  FREQUENCY,
  GROUP_FREQUENCIES,
  SAVINGS_FREQUENCIES,
  CONTRIBUTION_STATUS,
  PAYOUT_STATUS,
  TRANSACTION_TYPE,
  CREDIT_TYPES,
  TRANSACTION_STATUS,
  PAYMENT_METHOD,
  MOMO_PROVIDERS,
  WITHDRAWAL_STATUS,
  SAVINGS_TYPE,
  SAVINGS_STATUS,
  NOTIFICATION_TYPE,
  SUPPORT_STATUS,
  values,
};
