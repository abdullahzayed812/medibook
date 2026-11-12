import { Router, type Request, type RequestHandler } from 'express';
import { z } from 'zod';
import { validate } from '../../shared/http/middleware/validate.js';
import { requestMeta } from '../../shared/http/request-meta.js';
import { body, pageQuery, params, query } from '../../shared/http/route-helpers.js';
import { principalOf, requireTenant } from '../access/index.js';
import { idSchema } from '../platform/index.js';
import type { DoctorAssignmentService } from './assignments.service.js';
import type { ServiceCatalogService } from './catalog.service.js';
import type { ScheduleService } from './schedules.service.js';
import {
  assignmentBody,
  assignmentPatch,
  deactivateBody,
  doctorServiceBody,
  exceptionBody,
  offeringBody,
  rangeQuery,
  scheduleBody,
  serviceCreate,
  servicePatch,
} from './schemas.js';

const p = (shape: z.ZodRawShape): RequestHandler => validate({ params: z.object(shape) });
const statusFilter = <T extends readonly [string, ...string[]]>(values: T) =>
  pageQuery.extend({ status: z.enum(values).optional() });

/**
 * Task 04 clinic setup API (all under `X-Clinic-Id`). Branch ids in paths are re-resolved
 * against the caller's memberships (see context.ts) — never trusted as context.
 */
export function createClinicSetupRouter(deps: {
  authenticate: RequestHandler;
  clinicContext: RequestHandler;
  assignments: DoctorAssignmentService;
  catalog: ServiceCatalogService;
  schedules: ScheduleService;
}): Router {
  const r = Router();
  const { authenticate: auth, clinicContext: ctx, assignments, catalog, schedules } = deps;
  const ids = {
    branch: p({ branchId: idSchema }),
    branchService: p({ branchId: idSchema, serviceId: idSchema }),
    assignment: p({ assignmentId: idSchema }),
    assignmentService: p({ assignmentId: idSchema, serviceId: idSchema }),
    membership: p({ membershipId: idSchema }),
    service: p({ serviceId: idSchema }),
    schedule: p({ scheduleId: idSchema }),
    exception: p({ exceptionId: idSchema }),
  };
  const who = (req: Request) => [principalOf(req), requireTenant(req)] as const;
  const id = (req: Request, key: string) => params<Record<string, string>>(req)[key] ?? '';

  // ---------- doctor branch assignments ----------
  r.get(
    '/clinic/branches/:branchId/doctors',
    auth,
    ctx,
    ids.branch,
    validate({ query: statusFilter(['ACTIVE', 'INACTIVE'] as const) }),
    async (req, res) => {
      res.json(await assignments.listForBranch(...who(req), id(req, 'branchId'), query(req)));
    },
  );
  r.post(
    '/clinic/branches/:branchId/doctors',
    auth,
    ctx,
    ids.branch,
    validate({ body: assignmentBody }),
    async (req, res) => {
      res.status(201).json({
        data: await assignments.assign(
          ...who(req),
          id(req, 'branchId'),
          body(req),
          requestMeta(req),
        ),
      });
    },
  );
  r.get(
    '/clinic/doctors/:membershipId/branches',
    auth,
    ctx,
    ids.membership,
    validate({ query: z.object({ status: z.enum(['ACTIVE', 'INACTIVE']).optional() }) }),
    async (req, res) => {
      res.json({
        data: await assignments.listForDoctor(...who(req), id(req, 'membershipId'), query(req)),
      });
    },
  );
  r.get('/clinic/me/doctor-assignments', auth, ctx, async (req, res) => {
    res.json({ data: await assignments.mine(...who(req)) });
  });
  r.get('/clinic/doctor-assignments/:assignmentId', auth, ctx, ids.assignment, async (req, res) => {
    res.json({ data: await assignments.get(...who(req), id(req, 'assignmentId')) });
  });
  r.patch(
    '/clinic/doctor-assignments/:assignmentId',
    auth,
    ctx,
    ids.assignment,
    validate({ body: assignmentPatch }),
    async (req, res) => {
      res.json({
        data: await assignments.updateNotes(
          ...who(req),
          id(req, 'assignmentId'),
          body<{ notes: string | null }>(req).notes,
          requestMeta(req),
        ),
      });
    },
  );
  r.post(
    '/clinic/doctor-assignments/:assignmentId/deactivate',
    auth,
    ctx,
    ids.assignment,
    validate({ body: deactivateBody }),
    async (req, res) => {
      res.json({
        data: await assignments.deactivate(
          ...who(req),
          id(req, 'assignmentId'),
          body<{ reason: string }>(req).reason,
          requestMeta(req),
        ),
      });
    },
  );

  // ---------- clinic services ----------
  r.get(
    '/clinic/services',
    auth,
    ctx,
    validate({
      query: statusFilter(['ACTIVE', 'INACTIVE'] as const).extend({
        specialty: z.string().max(50).optional(),
      }),
    }),
    async (req, res) => {
      res.json(await catalog.list(...who(req), query(req)));
    },
  );
  r.post('/clinic/services', auth, ctx, validate({ body: serviceCreate }), async (req, res) => {
    res.status(201).json({ data: await catalog.create(...who(req), body(req), requestMeta(req)) });
  });
  r.get('/clinic/services/:serviceId', auth, ctx, ids.service, async (req, res) => {
    res.json({ data: await catalog.get(...who(req), id(req, 'serviceId')) });
  });
  r.patch(
    '/clinic/services/:serviceId',
    auth,
    ctx,
    ids.service,
    validate({ body: servicePatch }),
    async (req, res) => {
      res.json({
        data: await catalog.update(...who(req), id(req, 'serviceId'), body(req), requestMeta(req)),
      });
    },
  );

  // ---------- branch service offerings ----------
  r.get(
    '/clinic/branches/:branchId/services',
    auth,
    ctx,
    ids.branch,
    validate({
      query: statusFilter(['ACTIVE', 'INACTIVE'] as const).extend({
        serviceId: idSchema.optional(),
      }),
    }),
    async (req, res) => {
      res.json(await catalog.listOfferings(...who(req), id(req, 'branchId'), query(req)));
    },
  );
  r.get(
    '/clinic/branches/:branchId/services/:serviceId',
    auth,
    ctx,
    ids.branchService,
    async (req, res) => {
      res.json({
        data: await catalog.getOffering(...who(req), id(req, 'branchId'), id(req, 'serviceId')),
      });
    },
  );
  r.put(
    '/clinic/branches/:branchId/services/:serviceId',
    auth,
    ctx,
    ids.branchService,
    validate({ body: offeringBody }),
    async (req, res) => {
      const result = await catalog.upsertOffering(
        ...who(req),
        id(req, 'branchId'),
        id(req, 'serviceId'),
        body(req),
        requestMeta(req),
      );
      res.status(result.created ? 201 : 200).json({ data: result.offering });
    },
  );
  r.get(
    '/clinic/branches/:branchId/services/:serviceId/doctors',
    auth,
    ctx,
    ids.branchService,
    async (req, res) => {
      res.json({
        data: await catalog.listServiceDoctors(
          ...who(req),
          id(req, 'branchId'),
          id(req, 'serviceId'),
        ),
      });
    },
  );

  // ---------- doctor ↔ service ----------
  r.get(
    '/clinic/doctor-assignments/:assignmentId/services',
    auth,
    ctx,
    ids.assignment,
    validate({ query: z.object({ status: z.enum(['ACTIVE', 'ENDED']).optional() }) }),
    async (req, res) => {
      res.json({
        data: await catalog.listDoctorServices(...who(req), id(req, 'assignmentId'), query(req)),
      });
    },
  );
  r.put(
    '/clinic/doctor-assignments/:assignmentId/services/:serviceId',
    auth,
    ctx,
    ids.assignmentService,
    validate({ body: doctorServiceBody }),
    async (req, res) => {
      const result = await catalog.assignDoctorService(
        ...who(req),
        id(req, 'assignmentId'),
        id(req, 'serviceId'),
        body(req),
        requestMeta(req),
      );
      res.status(result.created ? 201 : 200).json({ data: result.doctorService });
    },
  );
  r.delete(
    '/clinic/doctor-assignments/:assignmentId/services/:serviceId',
    auth,
    ctx,
    ids.assignmentService,
    async (req, res) => {
      await catalog.endDoctorService(
        ...who(req),
        id(req, 'assignmentId'),
        id(req, 'serviceId'),
        requestMeta(req),
      );
      res.status(204).end();
    },
  );

  // ---------- branch operating hours & exceptions ----------
  const scheduleList = validate({ query: statusFilter(['ACTIVE', 'INACTIVE'] as const) });
  const exceptionList = validate({
    query: statusFilter(['ACTIVE', 'CANCELLED'] as const).extend({
      from: z.iso.date().optional(),
      to: z.iso.date().optional(),
    }),
  });
  r.get(
    '/clinic/branches/:branchId/hours',
    auth,
    ctx,
    ids.branch,
    scheduleList,
    async (req, res) => {
      res.json(await schedules.listBranchHours(...who(req), id(req, 'branchId'), query(req)));
    },
  );
  r.post(
    '/clinic/branches/:branchId/hours',
    auth,
    ctx,
    ids.branch,
    validate({ body: scheduleBody }),
    async (req, res) => {
      res.status(201).json({
        data: await schedules.createBranchHours(
          ...who(req),
          id(req, 'branchId'),
          body(req),
          requestMeta(req),
        ),
      });
    },
  );
  r.get(
    '/clinic/branches/:branchId/opening-time',
    auth,
    ctx,
    ids.branch,
    validate({ query: rangeQuery }),
    async (req, res) => {
      res.json({
        data: await schedules.branchOpeningTime(...who(req), id(req, 'branchId'), query(req)),
      });
    },
  );
  r.get(
    '/clinic/branches/:branchId/exceptions',
    auth,
    ctx,
    ids.branch,
    exceptionList,
    async (req, res) => {
      res.json(
        await schedules.listExceptions(...who(req), { branchId: id(req, 'branchId') }, query(req)),
      );
    },
  );
  r.post(
    '/clinic/branches/:branchId/exceptions',
    auth,
    ctx,
    ids.branch,
    validate({ body: exceptionBody }),
    async (req, res) => {
      res.status(201).json({
        data: await schedules.createException(
          ...who(req),
          { branchId: id(req, 'branchId') },
          body(req),
          requestMeta(req),
        ),
      });
    },
  );

  // ---------- doctor schedules, exceptions, working time ----------
  r.get(
    '/clinic/doctor-assignments/:assignmentId/schedules',
    auth,
    ctx,
    ids.assignment,
    scheduleList,
    async (req, res) => {
      res.json(
        await schedules.listDoctorSchedules(...who(req), id(req, 'assignmentId'), query(req)),
      );
    },
  );
  r.post(
    '/clinic/doctor-assignments/:assignmentId/schedules',
    auth,
    ctx,
    ids.assignment,
    validate({ body: scheduleBody }),
    async (req, res) => {
      res.status(201).json({
        data: await schedules.createDoctorSchedule(
          ...who(req),
          id(req, 'assignmentId'),
          body(req),
          requestMeta(req),
        ),
      });
    },
  );
  r.get(
    '/clinic/doctor-assignments/:assignmentId/exceptions',
    auth,
    ctx,
    ids.assignment,
    exceptionList,
    async (req, res) => {
      res.json(
        await schedules.listExceptions(
          ...who(req),
          { assignmentId: id(req, 'assignmentId') },
          query(req),
        ),
      );
    },
  );
  r.post(
    '/clinic/doctor-assignments/:assignmentId/exceptions',
    auth,
    ctx,
    ids.assignment,
    validate({ body: exceptionBody }),
    async (req, res) => {
      res.status(201).json({
        data: await schedules.createException(
          ...who(req),
          { assignmentId: id(req, 'assignmentId') },
          body(req),
          requestMeta(req),
        ),
      });
    },
  );
  r.get(
    '/clinic/doctor-assignments/:assignmentId/working-time',
    auth,
    ctx,
    ids.assignment,
    validate({ query: rangeQuery }),
    async (req, res) => {
      res.json({
        data: await schedules.doctorWorkingTime(...who(req), id(req, 'assignmentId'), query(req)),
      });
    },
  );

  // ---------- any schedule version / exception ----------
  r.get('/clinic/schedules/:scheduleId', auth, ctx, ids.schedule, async (req, res) => {
    res.json({ data: await schedules.getSchedule(...who(req), id(req, 'scheduleId')) });
  });
  r.post(
    '/clinic/schedules/:scheduleId/revisions',
    auth,
    ctx,
    ids.schedule,
    validate({ body: scheduleBody }),
    async (req, res) => {
      res.status(201).json({
        data: await schedules.revise(
          ...who(req),
          id(req, 'scheduleId'),
          body(req),
          requestMeta(req),
        ),
      });
    },
  );
  r.post(
    '/clinic/schedules/:scheduleId/deactivate',
    auth,
    ctx,
    ids.schedule,
    validate({ body: deactivateBody }),
    async (req, res) => {
      res.json({
        data: await schedules.deactivate(
          ...who(req),
          id(req, 'scheduleId'),
          body<{ reason: string }>(req).reason,
          requestMeta(req),
        ),
      });
    },
  );
  r.post('/clinic/schedules/:scheduleId/activate', auth, ctx, ids.schedule, async (req, res) => {
    res.json({
      data: await schedules.activate(...who(req), id(req, 'scheduleId'), requestMeta(req)),
    });
  });
  r.post(
    '/clinic/schedule-exceptions/:exceptionId/cancel',
    auth,
    ctx,
    ids.exception,
    async (req, res) => {
      res.json({
        data: await schedules.cancelException(
          ...who(req),
          id(req, 'exceptionId'),
          requestMeta(req),
        ),
      });
    },
  );
  return r;
}
