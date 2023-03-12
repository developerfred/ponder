import type { Pool } from "pg";

import { DerivedField, FieldKind, ScalarField, Schema } from "@/schema/types";

import type { EntityFilter, EntityStore } from "./entityStore";
import {
  getColumnValuePairs,
  getWhereValue,
  sqlSymbolsForFilterType,
} from "./utils";

export class PostgresEntityStore implements EntityStore {
  pool: Pool;
  schema?: Schema;

  constructor({ pool }: { pool: Pool }) {
    this.pool = pool;
  }

  errorWrapper = <T extends Array<any>, U>(fn: (...args: T) => U) => {
    return (...args: T): U => {
      if (!this.schema) {
        throw new Error(
          `EntityStore has not been initialized with a schema yet`
        );
      }

      // No need to wrap this in an error handler the way its done in
      // the SqliteEntityStore.
      return fn(...args);
    };
  };

  async teardown() {
    if (!this.schema) return;

    await Promise.all(
      this.schema.entities.map(async (entity) => {
        await this.pool.query(`DROP TABLE IF EXISTS "${entity.id}"`);
      })
    );
  }

  async load(newSchema?: Schema) {
    // If there is an existing schema, this is a hot reload and the existing entity tables should be dropped.
    if (this.schema) {
      await this.teardown();
    }

    // If a new schema was provided, set it.
    if (newSchema) {
      this.schema = newSchema;
    }
    if (!this.schema) return;

    await Promise.all(
      this.schema.entities.map(async (entity) => {
        // Build the create table statement using field migration fragments.
        // TODO: Update this so the generation of the field migration fragments happens here
        // instead of when the Schema gets built.
        const columnStatements = entity.fields
          .filter(
            // This type guard is wrong, could actually be any FieldKind that's not derived (obvs)
            (field): field is ScalarField => field.kind !== FieldKind.DERIVED
          )
          .map((field) => field.migrateUpStatement);

        await this.pool.query(
          `CREATE TABLE "${entity.id}" (${columnStatements.join(", ")})`
        );
      })
    );
  }

  getEntity = this.errorWrapper(async (entityId: string, id: string) => {
    const statement = `SELECT "${entityId}".* FROM "${entityId}" WHERE "${entityId}"."id" = $1`;
    const { rows, rowCount } = await this.pool.query(statement, [id]);

    if (rowCount === 0) return null;
    return this.deserialize(entityId, rows[0]);
  });

  insertEntity = this.errorWrapper(
    async (entityId: string, id: string, instance: Record<string, unknown>) => {
      // If `instance.id` is defined, replace it with the id passed as a parameter.
      // Should also log a warning here.
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      instance.id = id;

      const pairs = getColumnValuePairs(instance);

      const insertValues = pairs.map(({ value }) => value);
      const insertFragment = `(${pairs
        .map(({ column }) => column)
        .join(", ")}) VALUES (${insertValues
        .map((_, idx) => `$${idx + 1}`)
        .join(", ")})`;

      const statement = `INSERT INTO "${entityId}" ${insertFragment} RETURNING *`;
      const { rows } = await this.pool.query(statement, insertValues);

      return this.deserialize(entityId, rows[0]);
    }
  );

  updateEntity = this.errorWrapper(
    async (entityId: string, id: string, instance: Record<string, unknown>) => {
      const pairs = getColumnValuePairs(instance);

      const updatePairs = pairs.filter(({ column }) => column !== "id");
      const updateValues = updatePairs.map(({ value }) => value);
      const updateFragment = updatePairs
        .map(({ column }, idx) => `${column} = $${idx + 1}`)
        .join(", ");

      const statement = `UPDATE "${entityId}" SET ${updateFragment} WHERE "id" = $${
        updatePairs.length + 1
      } RETURNING *`;
      updateValues.push(id);
      const { rows } = await this.pool.query(statement, updateValues);

      return this.deserialize(entityId, rows[0]);
    }
  );

  upsertEntity = this.errorWrapper(
    async (entityId: string, id: string, instance: Record<string, unknown>) => {
      // If `instance.id` is defined, replace it with the id passed as a parameter.
      // Should also log a warning here.
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      instance.id = id;

      const pairs = getColumnValuePairs(instance);

      const insertValues = pairs.map(({ value }) => value);
      const insertFragment = `(${pairs
        .map(({ column }) => column)
        .join(", ")}) VALUES (${insertValues
        .map((_, idx) => `$${idx + 1}`)
        .join(", ")})`;

      const updatePairs = pairs.filter(({ column }) => column !== "id");
      const updateValues = updatePairs.map(({ value }) => value);
      const updateFragment = updatePairs
        .map(
          ({ column }, idx) => `${column} = $${idx + 1 + insertValues.length}`
        )
        .join(", ");

      const statement = `INSERT INTO "${entityId}" ${insertFragment} ON CONFLICT("id") DO UPDATE SET ${updateFragment} RETURNING *`;
      const { rows } = await this.pool.query(statement, [
        ...insertValues,
        ...updateValues,
      ]);

      return this.deserialize(entityId, rows[0]);
    }
  );

  deleteEntity = this.errorWrapper(async (entityId: string, id: string) => {
    const statement = `DELETE FROM "${entityId}" WHERE "id" = $1`;
    const { rowCount } = await this.pool.query(statement, [id]);

    return rowCount === 1;
  });

  getEntities = this.errorWrapper(
    async (entityId: string, filter?: EntityFilter) => {
      const where = filter?.where;
      const first = filter?.first;
      const skip = filter?.skip;
      const orderBy = filter?.orderBy;
      const orderDirection = filter?.orderDirection;

      const fragments = [];

      if (where) {
        const whereFragments = Object.entries(where).map(([field, value]) => {
          const [fieldName, rawFilterType] = field.split(/_(.*)/s);
          // This is a hack to handle the "" operator, which the regex above doesn't handle
          const filterType = rawFilterType === undefined ? "" : rawFilterType;
          const sqlSymbols = sqlSymbolsForFilterType[filterType];
          if (!sqlSymbols) {
            throw new Error(
              `SQL operators not found for filter type: ${filterType}`
            );
          }

          const whereValue = getWhereValue(value, sqlSymbols);

          return `"${fieldName}" ${whereValue}`;
        });

        fragments.push(`WHERE ${whereFragments.join(" AND ")}`);
      }

      if (orderBy) {
        fragments.push(`ORDER BY "${orderBy}"`);
      }

      if (orderDirection) {
        fragments.push(`${orderDirection}`);
      }

      if (first) {
        fragments.push(`LIMIT ${first}`);
      }

      if (skip) {
        if (!first) {
          fragments.push(`LIMIT -1`); // Must add a no-op limit for SQLite to handle offset
        }
        fragments.push(`OFFSET ${skip}`);
      }

      const statement = `SELECT * FROM "${entityId}" ${fragments.join(" ")}`;
      const { rows } = await this.pool.query(statement);

      return rows.map((instance) => this.deserialize(entityId, instance));
    }
  );

  getEntityDerivedField = this.errorWrapper(
    async (entityId: string, instanceId: string, derivedFieldName: string) => {
      const entity = this.schema?.entities.find((e) => e.id === entityId);
      if (!entity) {
        throw new Error(`Entity not found in schema for ID: ${entityId}`);
      }

      const derivedField = entity.fields.find(
        (field): field is DerivedField =>
          field.kind === FieldKind.DERIVED && field.name === derivedFieldName
      );

      if (!derivedField) {
        throw new Error(
          `Derived field not found: ${entity.name}.${derivedFieldName}`
        );
      }

      const derivedFromEntity = this.schema?.entities.find(
        (e) => e.name === derivedField.derivedFromEntityName
      );
      if (!derivedFromEntity) {
        throw new Error(
          `Entity not found in schema for name: ${derivedField.derivedFromEntityName}`
        );
      }

      const derivedFieldInstances = await this.getEntities(
        derivedFromEntity.id,
        {
          where: {
            [derivedField.derivedFromFieldName]: instanceId,
          },
        }
      );

      return derivedFieldInstances;
    }
  );

  deserialize = (entityId: string, instance: Record<string, unknown>) => {
    if (!this.schema) {
      throw new Error(`EntityStore has not been initialized with a schema yet`);
    }

    const entity = this.schema?.entities.find((e) => e.id === entityId);
    if (!entity) {
      throw new Error(`Entity not found in schema for ID: ${entityId}`);
    }

    const deserializedInstance = { ...instance };

    // For each property on the instance, look for a field defined on the entity
    // with the same name and apply any required deserialization transforms.
    Object.entries(instance).forEach(([fieldName, value]) => {
      const field = entity.fieldByName[fieldName];
      if (!field) return;

      if (field.baseGqlType.toString() === "Boolean") {
        deserializedInstance[fieldName] = value === 1 ? true : false;
        return;
      }

      if (field.kind === FieldKind.LIST) {
        deserializedInstance[fieldName] = JSON.parse(value as string);
        return;
      }

      deserializedInstance[fieldName] = value;
    });

    return deserializedInstance as Record<string, unknown>;
  };
}