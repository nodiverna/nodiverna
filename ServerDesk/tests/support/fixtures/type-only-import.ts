// Imports types without the `type` keyword; the loader must drop the import.
import {Labelled, Shape} from './shapes';

export function describeShape(shape: Shape): Labelled {
  return {label: `${shape.name} (${shape.corners})`};
}
