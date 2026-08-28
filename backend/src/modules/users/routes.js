const {
  sanitizationMiddleware: sanitize,
} = require('../../middleware/sanitize');
const auth = require('../../middleware/auth');
const rbac = require('../../middleware/rbac');
const ownership = require('../../middleware/ownership');
const repo = require('./repository');
const argon2 = require('argon2');
const { z } = require('zod');
const authRepo = require('../auth/repository');
const { toSchema } = require('../../utils/schemaHelper');
const { isValidStep } = require('../../utils/hierarchy');

const listUsersQuerySchema = z.object({
  search: z.string().trim().max(100).optional(),
  role: z.enum(['ADMIN', 'SENIOR_TL', 'TL', 'CAPTAIN', 'INTERN']).optional(),
  suspended: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const USER_ROLES = [
  'ADMIN',
  'MANAGEMENT',
  'HR',
  'SENIOR_TL',
  'TL',
  'CAPTAIN',
  'INTERN',
];

const updateUserSchema = z
  .object({
    full_name: z.string().trim().min(1).max(255).optional(),
    email: z.string().trim().email().max(255).optional(),
    role: z.enum(USER_ROLES).optional(),
    department_id: z.string().uuid().nullable().optional(),
    manager_id: z.string().uuid().nullable().optional(),
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one editable field is required',
  });

const allowedAvatarExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];

const isValidAvatarUrl = (val) => {
  if (typeof val !== 'string') return false;
  if (val.startsWith('/uploads/')) return true;

  try {
    const url = new URL(val);

    if (!['http:', 'https:'].includes(url.protocol)) return false;

    const pathname = url.pathname.toLowerCase();
    return allowedAvatarExtensions.some((ext) => pathname.endsWith(ext));
  } catch {
    return false;
  }
};

const changePasswordSchema = z.object({
  oldPassword: z.string(),
  newPassword: z.string().min(8),
});

const updateProfileSchema = z.object({
  full_name: z.string().optional(),
  phone: z.string().optional(),
  college: z.string().optional(),
  course: z.string().optional(),
  year_of_study: z.string().optional(),
  position: z.string().optional(),
  joining_date: z.string().optional(),
  internship_status: z.string().optional(),
  location: z.string().optional(),
  notes: z.string().optional(),
  avatar_url: z
    .string()
    .url()
    .regex(/^https?:\/\/.+\.(jpg|jpeg|png|gif|webp)$/i)
    .optional(),
});

async function routes(fastify) {
  // Admin: list users (paginated, with total count)
  fastify.get(
    '/',
    {
      preHandler: [auth, rbac('ADMIN')],
      schema: {
        tags: ['Users'],
        description: 'List all users (Admin only)',
        querystring: {
          type: 'object',
          properties: {
            search: { type: 'string', maxLength: 100 },
            role: {
              type: 'string',
              enum: ['ADMIN', 'SENIOR_TL', 'TL', 'CAPTAIN', 'INTERN'],
            },
            suspended: { type: 'string', enum: ['true', 'false'] },
            page: { type: 'integer', minimum: 1, default: 1 },
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          },
        },
      },
    },
    async (req, reply) => {
      const parsed = listUsersQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Invalid query parameters',
          details: parsed.error.issues,
        });
      }

      const { search, role, suspended, page, limit } = parsed.data;
      const offset = (page - 1) * limit;

      return repo.listUsersPaginated({
        search,
        role,
        suspended,
        page,
        limit,
        offset,
      });
    }
  );

  fastify.get(
    '/department/:departmentId/members',
    {
      preHandler: [auth, rbac('ADMIN')],
      schema: {
        tags: ['Users'],
        params: {
          type: 'object',
          required: ['departmentId'],
          properties: { departmentId: { type: 'string', format: 'uuid' } },
        },
      },
    },
    async (req) =>
      (await repo.listDepartmentMembers(req.params.departmentId)).rows
  );
  fastify.patch(
    '/:id/hierarchy',
    {
      preHandler: [auth, rbac('ADMIN'), sanitize],
      schema: {
        tags: ['Users'],
        body: {
          type: 'object',
          required: ['role', 'department_id'],
          additionalProperties: false,
          properties: {
            role: { type: 'string', enum: ['TL', 'CAPTAIN', 'INTERN'] },
            department_id: { type: 'string', format: 'uuid' },
            captain_ids: {
              type: 'array',
              items: { type: 'string', format: 'uuid' },
              default: [],
            },
            intern_ids: {
              type: 'array',
              items: { type: 'string', format: 'uuid' },
              default: [],
            },
            assign_all_captains: { type: 'boolean', default: false },
            assign_all_interns: { type: 'boolean', default: false },
          },
        },
      },
    },
    async (req, reply) => {
      try {
        return await repo.updateHierarchyAssignment({
          userId: req.params.id,
          role: req.body.role,
          departmentId: req.body.department_id,
          captainIds: req.body.captain_ids || [],
          internIds: req.body.intern_ids || [],
          assignAllCaptains: req.body.assign_all_captains || false,
          assignAllInterns: req.body.assign_all_interns || false,
        });
      } catch (error) {
        if (error.statusCode)
          return reply.status(error.statusCode).send({ error: error.message });
        throw error;
      }
    }
  );
  // Get own profile
  fastify.get(
    '/me',
    {
      preHandler: [auth],
      schema: { tags: ['Users'], description: 'Get own profile' },
    },
    async (req) => {
      const {
        rows: [user],
      } = await repo.getUserById(req.user.id);
      return user;
    }
  );

  // Get single user (ownership check)
  fastify.get(
    '/:id',
    {
      preHandler: [auth, ownership('id')],
      schema: {
        tags: ['Users'],
        description: 'Get single user',
        params: { type: 'object', properties: { id: { type: 'string' } } },
      },
    },
    async (req, reply) => {
      const {
        rows: [user],
      } = await repo.getUserById(req.params.id);
      return user || reply.status(404).send({ error: 'Not found' });
    }
  );

  // Update user (admin only)
  fastify.patch(
    '/:id',
    {
      preHandler: [auth, rbac('ADMIN'), sanitize],
      schema: {
        tags: ['Users'],
        description: 'Update user (Admin only)',
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        body: {
          type: 'object',
          minProperties: 1,
          additionalProperties: false,
          properties: {
            full_name: { type: 'string', minLength: 1, maxLength: 255 },
            email: { type: 'string', format: 'email', maxLength: 255 },
            role: { type: 'string', enum: USER_ROLES },
            department_id: {
              anyOf: [{ type: 'string', format: 'uuid' }, { type: 'null' }],
            },
            manager_id: {
              anyOf: [{ type: 'string', format: 'uuid' }, { type: 'null' }],
            },
          },
        },
      },
    },
    async (req, reply) => {
      const parsed = updateUserSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Invalid user update',
          details: parsed.error.issues,
        });
      }

      const {
        rows: [targetUser],
      } = await repo.getUserById(req.params.id);

      if (!targetUser) {
        return reply.status(404).send({ error: 'User not found' });
      }

      const data = { ...parsed.data };
      if (data.email !== undefined) data.email = data.email.toLowerCase();

      const nextRole = data.role || targetUser.role;

      if (
        data.role !== undefined &&
        data.role !== targetUser.role &&
        (data.role === 'SENIOR_TL' || targetUser.role === 'SENIOR_TL')
      ) {
        return reply.status(409).send({
          error: 'Senior TL changes must use Departments → Replace Senior TL.',
        });
      }

      if (
        data.role !== undefined &&
        data.role !== targetUser.role &&
        (targetUser.role === 'ADMIN' || data.role === 'ADMIN')
      ) {
        return reply.status(409).send({
          error: 'Admin role is protected and cannot be changed.',
        });
      }

      if (data.department_id) {
        const department = await repo.getDepartmentById(data.department_id);
        if (!department) {
          return reply.status(400).send({ error: 'Department not found' });
        }
      }

      if (
        data.manager_id === null &&
        targetUser.manager_id &&
        (await repo.countDirectReports(req.params.id)) > 0
      ) {
        return reply.status(409).send({
          error:
            'Cannot remove this manager while active users report to them. Use the department TL handover workflow.',
        });
      }

      if (data.manager_id !== undefined && data.manager_id !== null) {
        if (data.manager_id === req.params.id) {
          return reply.status(400).send({
            error: 'A user cannot manage their own account',
          });
        }

        const {
          rows: [manager],
        } = await repo.getUserById(data.manager_id);

        if (!manager) {
          return reply.status(400).send({ error: 'Manager not found' });
        }

        if (!isValidStep(manager.role, nextRole)) {
          return reply.status(400).send({
            error: `Invalid hierarchy: ${manager.role} cannot manage ${nextRole}`,
          });
        }
      } else if (data.role !== undefined && targetUser.manager_id) {
        const {
          rows: [manager],
        } = await repo.getUserById(targetUser.manager_id);

        if (manager && !isValidStep(manager.role, nextRole)) {
          return reply.status(400).send({
            error: 'Select a valid manager when changing this user role',
          });
        }
      }

      try {
        const updatedUser = await repo.updateUser(req.params.id, data);

        req.auditOnResponse = {
          userId: req.user.id,
          action: 'USER_UPDATED',
          resourceType: 'user',
          resourceId: req.params.id,
          details: { fields: Object.keys(data) },
          oldValue: {
            role: targetUser.role,
            department_id: targetUser.department_id,
            manager_id: targetUser.manager_id,
          },
          newValue: {
            role: updatedUser.role,
            department_id: updatedUser.department_id,
            manager_id: updatedUser.manager_id,
          },
        };

        return { message: 'User updated', user: updatedUser };
      } catch (error) {
        if (error.code === '23505') {
          return reply.status(409).send({
            error: 'A user with this email already exists',
          });
        }
        throw error;
      }
    }
  );

  // Suspend / Activate / Soft delete (admin only)
  fastify.patch(
    '/:id/suspend',
    {
      preHandler: [auth, rbac('ADMIN'), sanitize],
      schema: {
        tags: ['Users'],
        description: 'Suspend user (Admin only)',
        params: { type: 'object', properties: { id: { type: 'string' } } },
      },
    },
    async (req, reply) => {
      // Prevent self-suspension
      if (req.user.id === req.params.id) {
        return reply.status(400).send({
          error: 'You cannot suspend your own account',
        });
      }

      const {
        rows: [targetUser],
      } = await repo.getUserById(req.params.id);

      if (!targetUser) {
        return reply.status(404).send({ error: 'User not found' });
      }
      if (targetUser.role === 'ADMIN') {
        return reply.status(409).send({
          error: 'Admin accounts cannot be suspended.',
        });
      }

      await repo.suspendUser(req.params.id);

      req.auditOnResponse = {
        userId: req.user.id,
        action: 'USER_SUSPENDED',
        resourceType: 'user',
        resourceId: req.params.id,
      };

      return { message: 'Suspended' };
    }
  );

  fastify.patch(
    '/:id/activate',
    {
      preHandler: [auth, rbac('ADMIN'), sanitize],
      schema: {
        tags: ['Users'],
        description: 'Activate user (Admin only)',
        params: { type: 'object', properties: { id: { type: 'string' } } },
      },
    },
    async (req, reply) => {
      const {
        rows: [targetUser],
      } = await repo.getUserById(req.params.id);
      if (!targetUser)
        return reply.status(404).send({ error: 'User not found' });
      if (targetUser.role === 'ADMIN') {
        return reply.status(409).send({
          error: 'Admin accounts cannot be activated through user management.',
        });
      }
      await repo.activateUser(req.params.id);

      req.auditOnResponse = {
        userId: req.user.id,
        action: 'USER_ACTIVATED',
        resourceType: 'user',
        resourceId: req.params.id,
      };

      return { message: 'Activated' };
    }
  );

  fastify.delete(
    '/:id',
    {
      preHandler: [auth, rbac('ADMIN')],
      schema: {
        tags: ['Users'],
        description: 'Soft-delete user (Admin only)',
        params: { type: 'object', properties: { id: { type: 'string' } } },
      },
    },
    async (req, reply) => {
      // Prevent self-deletion
      if (req.user.id === req.params.id) {
        return reply.status(400).send({
          error: 'You cannot delete your own account',
        });
      }

      const {
        rows: [targetUser],
      } = await repo.getUserById(req.params.id);

      if (!targetUser) {
        return reply.status(404).send({ error: 'User not found' });
      }
      if (targetUser.role === 'ADMIN') {
        return reply.status(409).send({
          error: 'Admin accounts cannot be deleted.',
        });
      }

      await repo.softDeleteUser(req.params.id);

      req.auditOnResponse = {
        userId: req.user.id,
        action: 'USER_DELETED',
        resourceType: 'user',
        resourceId: req.params.id,
      };

      return { message: 'Soft-deleted' };
    }
  );

  // Change own password
  fastify.patch(
    '/me/password',
    {
      preHandler: [auth, sanitize],
      schema: {
        tags: ['Users'],
        description: 'Change own password',
        body: toSchema(changePasswordSchema),
      },
    },
    async (req, reply) => {
      const schema = z.object({
        oldPassword: z.string(),
        newPassword: z.string().min(8),
      });

      const { oldPassword, newPassword } = schema.parse(req.body);
      const user = await authRepo.findById(req.user.id);

      if (!user) return reply.status(404).send({ error: 'User not found' });

      const valid = await authRepo.verifyPassword(user, oldPassword);

      if (!valid) {
        return reply
          .status(400)
          .send({ error: 'Current password is incorrect' });
      }

      const newHash = await argon2.hash(newPassword);

      await authRepo.updatePassword(req.user.id, newHash);

      // Use the deferred audit log pattern for consistency
      req.auditOnResponse = {
        userId: req.user.id,
        action: 'PASSWORD_CHANGED',
        resourceType: 'user',
        resourceId: req.user.id,
      };

      return { message: 'Password updated' };
    }
  );

  // Update own profile
  fastify.patch(
    '/me',
    {
      preHandler: [auth, sanitize],
      schema: {
        tags: ['Users'],
        description: 'Update own profile',
        body: toSchema(updateProfileSchema),
      },
    },
    async (req) => {
      const schema = z.object({
        full_name: z.string().optional(),
        phone: z.string().optional(),
        college: z.string().optional(),
        course: z.string().optional(),
        year_of_study: z.string().optional(),
        position: z.string().optional(),
        joining_date: z.string().optional(),
        internship_status: z.string().optional(),
        location: z.string().optional(),
        notes: z.string().optional(),
        avatar_url: z
          .string()
          .refine((val) => isValidAvatarUrl(val), {
            message: 'Must be a valid image URL or an internal upload path',
          })
          .optional(),
      });

      const data = schema.parse(req.body);

      await authRepo.updateProfile(req.user.id, data);

      return { message: 'Profile updated' };
    }
  );
}

module.exports = routes;
