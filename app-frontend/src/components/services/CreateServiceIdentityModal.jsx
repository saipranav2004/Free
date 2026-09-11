import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Boxes, Plus } from 'lucide-react'
import { createServiceIdentity } from '../../api/serviceIdentities'
import { Modal } from '../common/Modal'
import { Field, inputClass } from '../common/FormFields'
import { Button } from '../common/Button'
import { apiErrorMessage } from '../../lib/apiError'

// Registering the principal is deliberately separate from giving it anything.
// A new identity holds no token and no grant, so creating one cannot widen
// access on its own; that is why this modal is not MFA-gated while minting a
// token and granting a scope both are.
export function CreateServiceIdentityModal({ open, onClose, onCreated }) {
  const queryClient = useQueryClient()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [environment, setEnvironment] = useState('')
  const [rateLimit, setRateLimit] = useState('')
  const [error, setError] = useState(null)

  const reset = () => {
    setName('')
    setDescription('')
    setEnvironment('')
    setRateLimit('')
    setError(null)
  }

  const mutation = useMutation({
    mutationFn: () =>
      createServiceIdentity({
        name: name.trim(),
        description: description.trim(),
        environment: environment.trim(),
        max_secrets_per_minute: Number(rateLimit) || 0,
      }),
    onSuccess: (identity) => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'services'] })
      toast.success('Service identity created', {
        description: 'It holds no token and no grant yet, so it cannot read anything.',
      })
      reset()
      onCreated?.(identity)
      onClose?.()
    },
    onError: (err) => setError(apiErrorMessage(err)),
  })

  const valid = name.trim().length > 1

  return (
    <Modal
      open={open}
      onClose={() => {
        reset()
        onClose?.()
      }}
      title="Register a service identity"
      description="A non-human principal that reads secrets without a console session: an application, a job, a sidecar."
      icon={Boxes}
      busy={mutation.isPending}
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button
            variant="ghost"
            onClick={() => {
              reset()
              onClose?.()
            }}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            icon={Plus}
            loading={mutation.isPending}
            disabled={!valid}
            onClick={() => mutation.mutate()}
          >
            Create identity
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <Field
          label="Name"
          required
          htmlFor="svc-name"
          hint="How it appears in the audit trail. Name it after the workload, not the person."
        >
          <input
            id="svc-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="billing-api-prod"
            className={inputClass(false)}
          />
        </Field>

        <Field label="Description" htmlFor="svc-desc">
          <input
            id="svc-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What this workload does and why it needs secrets"
            className={inputClass(false)}
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Environment" htmlFor="svc-env">
            <input
              id="svc-env"
              value={environment}
              onChange={(e) => setEnvironment(e.target.value)}
              placeholder="production"
              className={inputClass(false)}
            />
          </Field>

          <Field
            label="Reads per minute"
            htmlFor="svc-rate"
            hint="A leaked token is contained by how fast it can drain the vault. Leave empty for the server default."
          >
            <input
              id="svc-rate"
              type="number"
              min="0"
              value={rateLimit}
              onChange={(e) => setRateLimit(e.target.value)}
              placeholder="Server default"
              className={inputClass(false)}
            />
          </Field>
        </div>

        {error && (
          <p className="text-sm font-medium text-red-600 dark:text-red-400" role="alert">
            {error}
          </p>
        )}
      </div>
    </Modal>
  )
}
