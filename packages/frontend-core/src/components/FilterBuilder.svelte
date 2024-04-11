<script>
  import {
    Body,
    Button,
    Combobox,
    DatePicker,
    Icon,
    Input,
    Layout,
    Select,
    Label,
    Multiselect,
  } from "@budibase/bbui"
  import { FieldType, SearchQueryOperators } from "@budibase/types"
  import { generate } from "shortid"
  import { LuceneUtils, Constants } from "@budibase/frontend-core"
  import { getContext } from "svelte"

  const { OperatorOptions } = Constants

  export let schemaFields
  export let filters = []
  export let datasource
  export let allowBindings = false

  const context = getContext("context")

  $: fieldOptions = (schemaFields ?? [])
    .filter(field => getValidOperatorsForType(field).length)
    .map(field => ({
      label: field.displayName || field.name,
      value: field.name,
    }))

  const addFilter = () => {
    filters = [
      ...(filters || []),
      {
        id: generate(),
        field: null,
        operator: OperatorOptions.Equals.value,
        value: null,
        valueType: "Value",
      },
    ]
  }

  const removeFilter = id => {
    filters = filters.filter(field => field.id !== id)
  }

  const duplicateFilter = id => {
    const existingFilter = filters.find(filter => filter.id === id)
    const duplicate = { ...existingFilter, id: generate() }
    filters = [...filters, duplicate]
  }

  const onFieldChange = filter => {
    const previousType = filter.type
    sanitizeTypes(filter)
    sanitizeOperator(filter)
    sanitizeValue(filter, previousType)
  }

  const onOperatorChange = filter => {
    sanitizeOperator(filter)
    sanitizeValue(filter, filter.type)
  }

  const onValueTypeChange = filter => {
    sanitizeValue(filter)
  }

  const getFieldOptions = field => {
    const schema = schemaFields.find(x => x.name === field)
    return schema?.constraints?.inclusion || []
  }

  const getSchema = filter => {
    return schemaFields.find(field => field.name === filter.field)
  }

  const getValidOperatorsForType = filter => {
    if (!filter?.field && !filter?.name) {
      return []
    }

    return LuceneUtils.getValidOperatorsForType(
      filter,
      filter.field || filter.name,
      datasource
    )
  }

  $: valueTypeOptions = allowBindings ? ["Value", "Binding"] : ["Value"]

  const sanitizeTypes = filter => {
    // Update type based on field
    const fieldSchema = schemaFields.find(x => x.name === filter.field)
    filter.type = fieldSchema?.type
    filter.subtype = fieldSchema?.subtype

    // Update external type based on field
    filter.externalType = getSchema(filter)?.externalType
  }

  const sanitizeOperator = filter => {
    // Ensure a valid operator is selected
    const operators = getValidOperatorsForType(filter).map(x => x.value)
    if (!operators.includes(filter.operator)) {
      filter.operator = operators[0] ?? OperatorOptions.Equals.value
    }

    // Update the noValue flag if the operator does not take a value
    const noValueOptions = [
      OperatorOptions.Empty.value,
      OperatorOptions.NotEmpty.value,
    ]
    filter.noValue = noValueOptions.includes(filter.operator)
  }

  const sanitizeValue = (filter, previousType) => {
    // Check if the operator allows a value at all
    if (filter.noValue) {
      filter.value = null
      return
    }

    // Ensure array values are properly set and cleared
    if (Array.isArray(filter.value)) {
      if (filter.valueType !== "Value" || filter.type !== FieldType.ARRAY) {
        filter.value = null
      }
    } else if (
      filter.type === FieldType.ARRAY &&
      filter.valueType === "Value"
    ) {
      filter.value = []
    } else if (
      previousType !== filter.type &&
      (previousType === FieldType.BB_REFERENCE ||
        filter.type === FieldType.BB_REFERENCE)
    ) {
      filter.value = filter.type === FieldType.ARRAY ? [] : null
    }
  }
</script>

<div class="container" class:mobile={$context?.device?.mobile}>
  <Layout noPadding>
    <Body size="S">
      {#if !filters?.length}
        Add your first filter expression.
      {:else}
        <slot name="filteringHeroContent" />
      {/if}
    </Body>
    {#if filters?.length}
      <div class="filter-label">
        <Label>Filters</Label>
      </div>
      <div class="fields">
        {#each filters as filter}
          <Select
            bind:value={filter.field}
            options={fieldOptions}
            on:change={() => onFieldChange(filter)}
            placeholder="Column"
          />
          <Select
            disabled={!filter.field}
            options={getValidOperatorsForType(filter)}
            bind:value={filter.operator}
            on:change={() => onOperatorChange(filter)}
            placeholder={null}
          />
          {#if allowBindings}
            <Select
              disabled={filter.noValue || !filter.field}
              options={valueTypeOptions}
              bind:value={filter.valueType}
              on:change={() => onValueTypeChange(filter)}
              placeholder={null}
            />
          {/if}
          {#if allowBindings && filter.field && filter.valueType === "Binding"}
            <slot name="binding" {filter} />
          {:else if [FieldType.STRING, FieldType.LONGFORM, FieldType.NUMBER, FieldType.BIGINT, FieldType.FORMULA].includes(filter.type)}
            <Input disabled={filter.noValue} bind:value={filter.value} />
          {:else if filter.type === FieldType.ARRAY || (filter.type === FieldType.OPTIONS && filter.operator === SearchQueryOperators.ONE_OF)}
            <Multiselect
              disabled={filter.noValue}
              options={getFieldOptions(filter.field)}
              bind:value={filter.value}
            />
          {:else if filter.type === FieldType.OPTIONS}
            <Combobox
              disabled={filter.noValue}
              options={getFieldOptions(filter.field)}
              bind:value={filter.value}
            />
          {:else if filter.type === FieldType.BOOLEAN}
            <Combobox
              disabled={filter.noValue}
              options={[
                { label: "True", value: "true" },
                { label: "False", value: "false" },
              ]}
              bind:value={filter.value}
            />
          {:else if filter.type === FieldType.DATETIME}
            <DatePicker
              disabled={filter.noValue}
              enableTime={!getSchema(filter)?.dateOnly}
              timeOnly={getSchema(filter)?.timeOnly}
              bind:value={filter.value}
            />
          {:else}
            <Input disabled />
          {/if}
          <div class="controls">
            <Icon
              class
              name="Duplicate"
              hoverable
              size="S"
              on:click={() => duplicateFilter(filter.id)}
            />
          </div>
          <div class="controls">
            <Icon
              name="Close"
              hoverable
              size="S"
              on:click={() => removeFilter(filter.id)}
            />
          </div>
        {/each}
      </div>
    {/if}
    <div>
      <Button icon="AddCircle" size="M" secondary on:click={addFilter}>
        Add filter
      </Button>
    </div>
  </Layout>
</div>

<style>
  .container {
    width: 100%;
    max-width: 1000px;
    margin: 0 auto;
  }
  .fields {
    display: grid;
    column-gap: var(--spacing-l);
    row-gap: var(--spacing-s);
    align-items: center;
    grid-template-columns: 1fr 120px 1fr auto auto;
  }
  .controls {
    display: content;
  }

  .container.mobile .fields {
    grid-template-columns: 1fr;
  }
  .container.mobile .controls {
    display: flex;
    flex-direction: row;
    justify-content: flex-start;
    align-items: center;
    padding: var(--spacing-s) 0;
    gap: var(--spacing-s);
  }

  .filter-label {
    margin-bottom: var(--spacing-s);
  }
</style>