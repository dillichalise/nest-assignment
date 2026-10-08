import 'dotenv/config';
import * as bcrypt from 'bcrypt';
import dataSource from './data-source';
import { Role } from '../common/enums/role.enum';
import { User } from '../users/user.entity';

// Local development seed. Idempotent: existing users (by email) are skipped.
const SEED_USERS: { email: string; name: string; role: Role }[] = [
  { email: 'admin@example.com', name: 'Dilli Admin', role: Role.ADMIN },
  {
    email: 'reviewer@example.com',
    name: 'Dilli Reviewer',
    role: Role.REVIEWER,
  },
  { email: 'sales@example.com', name: 'Dilli Sales', role: Role.SALES },
  { email: 'sales2@example.com', name: 'Dilli Sales Two', role: Role.SALES },
];

async function seed() {
  const password = process.env.SEED_PASSWORD;
  if (!password) {
    throw new Error('SEED_PASSWORD is not set');
  }

  await dataSource.initialize();
  const repo = dataSource.getRepository(User);
  const passwordHash = await bcrypt.hash(password, 10);

  for (const user of SEED_USERS) {
    const exists = await repo.existsBy({ email: user.email });
    if (exists) {
      console.log(`skip    ${user.email} (already exists)`);
      continue;
    }
    await repo.save(repo.create({ ...user, passwordHash, isActive: true }));
    console.log(`created ${user.email} (${user.role})`);
  }
  await dataSource.destroy();
}

seed().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
