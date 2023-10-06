import {
  type GraphQLFieldConfig,
  type GraphQLFieldResolver,
  type GraphQLInputType,
  GraphQLInputObjectType,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLString,
} from "graphql";

import type { Entity } from "@/schema/types";

import type { Context, Source } from "./schema";
import { tsTypeToGqlScalar } from "./schema";

type PluralArgs = {
  timestamp?: number;
  where?: { [key: string]: number | string };
  first?: number;
  skip?: number;
  orderBy?: string;
  orderDirection?: "asc" | "desc";
};
type PluralResolver = GraphQLFieldResolver<Source, Context, PluralArgs>;

const tsTypeToGqlField = (key: string) => (key === "bigint" ? "bigInt" : key);

const operators = {
  universal: ["", "_not"],
  singular: ["_in", "_not_in"],
  plural: ["_has", "_not_has"],
  numeric: ["_gt", "_lt", "_gte", "_lte"],
  string: [
    "_contains",
    "_not_contains",
    "_starts_with",
    "_ends_with",
    "_not_starts_with",
    "_not_ends_with",
  ],
};

export const buildPluralField = ({
  entity,
  entityGqlType,
}: {
  entity: Entity;
  entityGqlType: GraphQLObjectType<Source, Context>;
}): GraphQLFieldConfig<Source, Context> => {
  const filterFields: Record<string, { type: GraphQLInputType }> = {};

  Object.keys(entity.columns).forEach((key) => {
    if (!entity.columns[key].list) {
      // Scalar fields => universal, singular, numeric OR string depending on base type
      // Note: Booleans => universal and singular only.
      operators.universal.forEach((suffix) => {
        filterFields[`${tsTypeToGqlField(key)}${suffix}`] = {
          type: tsTypeToGqlScalar[entity.columns[key].type],
        };
      });

      operators.singular.forEach((suffix) => {
        filterFields[`${tsTypeToGqlField(key)}${suffix}`] = {
          type: new GraphQLList(tsTypeToGqlScalar[entity.columns[key].type]),
        };
      });

      if (["int", "bigint", "float"].includes(entity.columns[key].type)) {
        operators.numeric.forEach((suffix) => {
          filterFields[`${tsTypeToGqlField(key)}${suffix}`] = {
            type: tsTypeToGqlScalar[entity.columns[key].type],
          };
        });
      }

      if (["string", "bytes"].includes(entity.columns[key].type)) {
        operators.string.forEach((suffix) => {
          filterFields[`${key}${suffix}`] = {
            type: tsTypeToGqlScalar[entity.columns[key].type],
          };
        });
      }
    } else {
      // List fields => universal, plural
      operators.universal.forEach((suffix) => {
        filterFields[`${tsTypeToGqlField(key)}${suffix}`] = {
          type: new GraphQLList(tsTypeToGqlScalar[entity.columns[key].type]),
        };
      });

      operators.plural.forEach((suffix) => {
        filterFields[`${tsTypeToGqlField(key)}${suffix}`] = {
          type: tsTypeToGqlScalar[entity.columns[key].type],
        };
      });
    }
  });

  const filterType = new GraphQLInputObjectType({
    name: `${entity.name}Filter`,
    fields: filterFields,
  });

  const resolver: PluralResolver = async (_, args, context) => {
    const { store } = context;

    const { timestamp, where, skip, first, orderBy, orderDirection } = args;

    return await store.findMany({
      modelName: entity.name,
      timestamp: timestamp ? timestamp : undefined,
      where: where ? buildWhereObject({ where }) : undefined,
      skip: skip,
      take: first,
      orderBy: orderBy ? { [orderBy]: orderDirection || "asc" } : undefined,
    });
  };

  return {
    type: new GraphQLNonNull(
      new GraphQLList(new GraphQLNonNull(entityGqlType))
    ),
    args: {
      skip: { type: GraphQLInt, defaultValue: 0 },
      first: { type: GraphQLInt, defaultValue: 100 },
      orderBy: { type: GraphQLString, defaultValue: "id" },
      orderDirection: { type: GraphQLString, defaultValue: "asc" },
      where: { type: filterType },
      timestamp: { type: GraphQLInt },
    },
    resolve: resolver,
  };
};

const graphqlFilterToStoreCondition = {
  "": "equals",
  not: "not",
  in: "in",
  not_in: "notIn",
  has: "has",
  not_has: "notHas",
  gt: "gt",
  lt: "lt",
  gte: "gte",
  lte: "lte",
  contains: "contains",
  not_contains: "notContains",
  starts_with: "startsWith",
  not_starts_with: "notStartsWith",
  ends_with: "endsWith",
  not_ends_with: "notEndsWith",
} as const;

function buildWhereObject({ where }: { where: Record<string, any> }) {
  const whereObject: Record<string, any> = {};

  Object.entries(where).forEach(([whereKey, rawValue]) => {
    const [fieldName, condition_] = whereKey.split(/_(.*)/s);
    // This is a hack to handle the "" operator, which the regex above doesn't handle
    const condition = (
      condition_ === undefined ? "" : condition_
    ) as keyof typeof graphqlFilterToStoreCondition;

    const storeCondition = graphqlFilterToStoreCondition[condition];
    if (!storeCondition) {
      throw new Error(
        `Invalid query: Unknown where condition: ${fieldName}_${condition}`
      );
    }

    whereObject[fieldName] = { [storeCondition]: rawValue };
  });

  return whereObject;
}
