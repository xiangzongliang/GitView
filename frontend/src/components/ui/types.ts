// Shared types for the ui/ primitives.

/** A single selectable entry in a SelectMenu. */
export interface SelectOption {
  label: string
  value: string
  /** optional Icon name rendered before the label */
  icon?: string
  disabled?: boolean
}

/** A titled group of options in a SelectMenu. */
export interface SelectGroup {
  group: string
  options: SelectOption[]
}

export type SelectEntry = SelectOption | SelectGroup
