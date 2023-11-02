import { BadRequestError, context, db as dbCore } from "@budibase/backend-core"
import {
  BBReferenceFieldMetadata,
  FieldSchema,
  FieldSubtype,
  InnerLink,
  InternalTable,
  isBBReferenceField,
  isRelationshipField,
  LinkDocument,
  RelationshipFieldMetadata,
  RelationshipType,
  Row,
  Table,
} from "@budibase/types"
import sdk from "../../../sdk"
import { isExternalTableID } from "../../../integrations/utils"
import { EventType, updateLinks } from "../../../db/linkedRows"
import { cloneDeep } from "lodash"
import { isInternalColumnName } from "@budibase/backend-core/src/db"

export interface MigrationResult {
  tablesUpdated: Table[]
}

export async function migrate(
  table: Table,
  oldColumn: FieldSchema,
  newColumn: FieldSchema
): Promise<MigrationResult> {
  if (newColumn.name in table.schema) {
    throw new BadRequestError(`Column "${newColumn.name}" already exists`)
  }

  if (newColumn.name === "") {
    throw new BadRequestError(`Column name cannot be empty`)
  }

  if (isInternalColumnName(newColumn.name)) {
    throw new BadRequestError(`Column name cannot be a reserved column name`)
  }

  table.schema[newColumn.name] = newColumn
  table = await sdk.tables.saveTable(table)

  let migrator = getColumnMigrator(table, oldColumn, newColumn)
  try {
    return await migrator.doMigration()
  } catch (e) {
    // If the migration fails then we need to roll back the table schema
    // change.
    delete table.schema[newColumn.name]
    await sdk.tables.saveTable(table)
    throw e
  }
}

interface ColumnMigrator {
  doMigration(): Promise<MigrationResult>
}

function getColumnMigrator(
  table: Table,
  oldColumn: FieldSchema,
  newColumn: FieldSchema
): ColumnMigrator {
  // For now, we're only supporting migrations of user relationships to user
  // columns in internal tables. In the future, we may want to support other
  // migrations but for now return an error if we aren't migrating a user
  // relationship.
  if (isExternalTableID(table._id!)) {
    throw new BadRequestError("External tables cannot be migrated")
  }

  if (!(oldColumn.name in table.schema)) {
    throw new BadRequestError(`Column "${oldColumn.name}" does not exist`)
  }

  if (!isBBReferenceField(newColumn)) {
    throw new BadRequestError(`Column "${newColumn.name}" is not a user column`)
  }

  if (newColumn.subtype !== "user" && newColumn.subtype !== "users") {
    throw new BadRequestError(`Column "${newColumn.name}" is not a user column`)
  }

  if (!isRelationshipField(oldColumn)) {
    throw new BadRequestError(
      `Column "${oldColumn.name}" is not a user relationship`
    )
  }

  if (oldColumn.tableId !== InternalTable.USER_METADATA) {
    throw new BadRequestError(
      `Column "${oldColumn.name}" is not a user relationship`
    )
  }

  if (oldColumn.relationshipType === RelationshipType.ONE_TO_MANY) {
    if (newColumn.subtype !== FieldSubtype.USER) {
      throw new BadRequestError(
        `Column "${oldColumn.name}" is a one-to-many column but "${newColumn.name}" is not a single user column`
      )
    }
    return new SingleUserColumnMigrator(table, oldColumn, newColumn)
  }
  if (
    oldColumn.relationshipType === RelationshipType.MANY_TO_MANY ||
    oldColumn.relationshipType === RelationshipType.MANY_TO_ONE
  ) {
    if (newColumn.subtype !== FieldSubtype.USERS) {
      throw new BadRequestError(
        `Column "${oldColumn.name}" is a ${oldColumn.relationshipType} column but "${newColumn.name}" is not a multi user column`
      )
    }
    return new MultiUserColumnMigrator(table, oldColumn, newColumn)
  }

  throw new BadRequestError(`Unknown migration type`)
}

abstract class UserColumnMigrator implements ColumnMigrator {
  constructor(
    protected table: Table,
    protected oldColumn: RelationshipFieldMetadata,
    protected newColumn: BBReferenceFieldMetadata
  ) {}

  abstract updateRow(row: Row, userLink: InnerLink): void

  getUserLink(link: LinkDocument) {
    const { doc1, doc2 } = link
    if (
      doc1.tableId === InternalTable.USER_METADATA &&
      doc2.tableId === this.table._id &&
      doc2.fieldName === this.oldColumn.name
    ) {
      return [doc1, doc2]
    }
    if (
      doc2.tableId === InternalTable.USER_METADATA &&
      doc1.tableId === this.table._id &&
      doc1.fieldName === this.oldColumn.name
    ) {
      return [doc2, doc1]
    }
    return [null, null]
  }

  async doMigration(): Promise<MigrationResult> {
    let oldTable = cloneDeep(this.table)
    let rows = await sdk.rows.fetchRaw(this.table._id!)
    let rowsById = rows.reduce((acc, row) => {
      acc[row._id!] = row
      return acc
    }, {} as Record<string, Row>)

    let links = await sdk.links.fetchWithDocument(this.table._id!)
    for (let link of links) {
      const [userLink, otherLink] = this.getUserLink(link)
      if (!userLink || !otherLink) {
        continue
      }

      let row = rowsById[otherLink.rowId]
      if (!row) {
        // This can happen if the row has been deleted but the link hasn't,
        // which was a state that was found during the initial testing of this
        // feature. Not sure exactly what can cause it, but best to be safe.
        continue
      }

      this.updateRow(row, userLink)
    }

    let db = context.getAppDB()
    await db.bulkDocs(rows)

    delete this.table.schema[this.oldColumn.name]
    this.table = await sdk.tables.saveTable(this.table)
    await updateLinks({
      eventType: EventType.TABLE_UPDATED,
      table: this.table,
      oldTable,
    })

    let otherTable = await sdk.tables.getTable(this.oldColumn.tableId)
    return {
      tablesUpdated: [this.table, otherTable],
    }
  }
}

class SingleUserColumnMigrator extends UserColumnMigrator {
  updateRow(row: Row, userLink: InnerLink): void {
    row[this.newColumn.name] = dbCore.getGlobalIDFromUserMetadataID(
      userLink.rowId
    )
  }
}

class MultiUserColumnMigrator extends UserColumnMigrator {
  updateRow(row: Row, userLink: InnerLink): void {
    if (!row[this.newColumn.name]) {
      row[this.newColumn.name] = []
    }
    row[this.newColumn.name].push(
      dbCore.getGlobalIDFromUserMetadataID(userLink.rowId)
    )
  }
}
