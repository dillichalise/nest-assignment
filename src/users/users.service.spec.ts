import { Repository } from 'typeorm';
import { User } from './user.entity';
import { UsersService } from './users.service';

describe('UsersService', () => {
  const user = { id: 'u1', email: 'pat@example.com' } as User;

  const build = (found: User | null = user) => {
    const query = {
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(found),
    };
    const repo = {
      findOneBy: jest.fn().mockResolvedValue(found),
      createQueryBuilder: jest.fn().mockReturnValue(query),
    };
    return {
      repo,
      query,
      service: new UsersService(repo as unknown as Repository<User>),
    };
  };

  describe('findByEmailWithPassword', () => {
    it.each([
      ['  Pat@Example.COM  ', 'pat@example.com'],
      ['SALES@EXAMPLE.COM', 'sales@example.com'],
      ['already@lower.case', 'already@lower.case'],
    ])(
      'looks %p up as %p, so login ignores case and padding',
      async (input, normalized) => {
        const { service, query } = build();

        await service.findByEmailWithPassword(input);

        expect(query.where).toHaveBeenCalledWith('user.email = :email', {
          email: normalized,
        });
      },
    );

    it('explicitly selects the password hash, which is hidden everywhere else', async () => {
      const { service, query } = build();
      await service.findByEmailWithPassword('pat@example.com');
      expect(query.addSelect).toHaveBeenCalledWith('user.passwordHash');
    });

    it('returns the user, or null when there is none', async () => {
      await expect(
        build(user).service.findByEmailWithPassword('a@b.co'),
      ).resolves.toBe(user);
      await expect(
        build(null).service.findByEmailWithPassword('a@b.co'),
      ).resolves.toBeNull();
    });
  });

  describe('findById', () => {
    it('does NOT select the password hash', async () => {
      const { service, repo } = build();
      await service.findById('u1');
      expect(repo.findOneBy).toHaveBeenCalledWith({ id: 'u1' });
      expect(repo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('returns null for an unknown id', async () => {
      await expect(build(null).service.findById('nope')).resolves.toBeNull();
    });
  });
});
