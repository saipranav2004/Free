import { useEffect, useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { FolderTree } from 'lucide-react'
import { createFolder } from '../../api/vault'
import { Modal } from '../common/Modal'
import { Field, inputClass, selectClass } from '../common/FormFields'
import { Button } from '../common/Button'
import { apiErrorMessage } from '../../lib/apiError'

const schema = z.object({
  name: z.string().trim().min(1, 'Required').max(255),
  path: z
    .string()
    .trim()
    .min(1, 'Required')
    .refine((v) => v.startsWith('/'), 'Path must start with “/”')
    .refine((v) => !/\/\//.test(v), 'No empty path segments'),
  parent_folder_id: z.string().optional(),
})

// Folder paths are a source of typos and mismatches ("Prod DBs" filed at
// /production). The path is now DERIVED from the name (and the chosen
// parent) as you type, and only stops following it once you edit it
// yourself, the same behaviour a slug field has everywhere else.
function slug(name) {
  return String(name || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function CreateFolderModal({ open, onClose, safeId, folders = [], parentFolderId }) {
  const queryClient = useQueryClient()
  const [pathEdited, setPathEdited] = useState(false)

  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    formState: { errors },
  } = useForm({
    resolver: zodResolver(schema),
    mode: 'onBlur',
    defaultValues: { name: '', path: '', parent_folder_id: parentFolderId || '' },
  })

  const name = watch('name')
  const parent = watch('parent_folder_id')

  useEffect(() => {
    if (open) {
      reset({ name: '', path: '', parent_folder_id: parentFolderId || '' })
      setPathEdited(false)
    }
  }, [open, parentFolderId, reset])

  useEffect(() => {
    if (pathEdited) return
    const parentPath = folders.find((f) => f.id === parent)?.path || ''
    const base = parentPath.replace(/\/$/, '')
    setValue('path', name ? `${base}/${slug(name)}` : '')
  }, [name, parent, folders, pathEdited, setValue])

  const mutation = useMutation({
    mutationFn: (values) =>
      createFolder(safeId, {
        name: values.name,
        path: values.path,
        parent_folder_id: values.parent_folder_id || undefined,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['vault', 'safes', safeId, 'folders'] })
      toast.success('Folder created')
      onClose()
    },
    onError: (err) => toast.error(apiErrorMessage(err)),
  })

  return (
    <Modal
      open={open}
      onClose={onClose}
      icon={FolderTree}
      title="Create a folder"
      description="Folders organise a safe's credentials. They carry no permissions of their own, access is still governed by policy."
      busy={mutation.isPending}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button form="create-folder-form" type="submit" variant="primary" loading={mutation.isPending}>
            Create folder
          </Button>
        </>
      }
    >
      <form
        id="create-folder-form"
        onSubmit={handleSubmit((v) => mutation.mutate(v))}
        noValidate
        className="space-y-4"
      >
        <Field label="Name" error={errors.name?.message} required htmlFor="folder-name">
          <input
            id="folder-name"
            autoComplete="off"
            placeholder="Production databases"
            className={inputClass(!!errors.name)}
            {...register('name')}
          />
        </Field>

        {folders.length > 0 && (
          <Field
            label="Parent folder"
            hint="Optional, leave at safe root for a top-level folder."
            htmlFor="folder-parent"
          >
            <select id="folder-parent" className={selectClass(false)} {...register('parent_folder_id')}>
              <option value="">Safe root</option>
              {folders.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.path || f.name}
                </option>
              ))}
            </select>
          </Field>
        )}

        <Field
          label="Path"
          error={errors.path?.message}
          hint="Derived from the name, edit it if you need a different path."
          required
          htmlFor="folder-path"
        >
          <input
            id="folder-path"
            placeholder="/prod-databases"
            className={inputClass(!!errors.path) + ' font-mono text-xs'}
            {...register('path', { onChange: () => setPathEdited(true) })}
          />
        </Field>
      </form>
    </Modal>
  )
}
