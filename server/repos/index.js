import { coreRepo } from './core.js';
import { billingRepo, bankRepo } from './billing.js';
import { complaintsRepo } from './complaints.js';
import { communityRepo } from './community.js';

// One bundle of repositories bound to an executor (a connection pool or an open transaction).
export function createRepos(tx, clock = () => new Date()) {
  return { core: coreRepo(tx, clock), billing: billingRepo(tx, clock), bank: bankRepo(tx, clock), complaints: complaintsRepo(tx), community: communityRepo(tx, clock), clock };
}
export { HttpError, isDuplicateError } from './util.js';
