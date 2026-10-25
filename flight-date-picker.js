/* Self-contained calendar date picker shared by desktop and iOS pages. */
;(function (root) {
  'use strict'

  const core = root.FlightCore
  const locale = root.navigator && root.navigator.language || 'en'
  const monthFormatter = new Intl.DateTimeFormat(locale, { month: 'long', timeZone: 'UTC' })
  const weekdayFormatter = new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' })
  const fullDateFormatter = new Intl.DateTimeFormat(locale, {
    year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC',
  })

  function localToday() {
    const date = new Date()
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  }

  function parts(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''))
    return match ? { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) } : null
  }

  function dateString(year, month, day) {
    const maxDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
    const safeDay = Math.min(Math.max(day, 1), maxDay)
    return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(safeDay).padStart(2, '0')}`
  }

  function formatDate(value) {
    const date = parts(value)
    if (!date) return ''
    return fullDateFormatter.format(new Date(Date.UTC(date.year, date.month - 1, date.day)))
  }

  function firstWeekday() {
    try {
      const firstDay = new Intl.Locale(locale).weekInfo.firstDay
      return firstDay % 7
    } catch {
      return 0
    }
  }

  function mount(input) {
    if (!input || !core) return null

    const wrapper = document.createElement('div')
    wrapper.className = 'flight-date-picker'
    input.parentNode.insertBefore(wrapper, input)
    wrapper.appendChild(input)
    input.type = 'hidden'
    input.required = false

    const trigger = document.createElement('button')
    trigger.type = 'button'
    trigger.className = 'flight-date-trigger'
    trigger.setAttribute('aria-haspopup', 'dialog')
    trigger.setAttribute('aria-expanded', 'false')
    trigger.setAttribute('aria-label', 'Choose flight date')
    wrapper.appendChild(trigger)

    const calendar = document.createElement('div')
    calendar.className = 'flight-date-calendar'
    calendar.hidden = true
    calendar.setAttribute('role', 'dialog')
    calendar.setAttribute('aria-label', 'Choose flight date')
    calendar.setAttribute('aria-modal', 'false')
    wrapper.appendChild(calendar)

    let visible = false
    let draftValue = input.value || ''
    let viewYear = parts(input.value)?.year || Number(localToday().slice(0, 4))
    let viewMonth = parts(input.value)?.month || Number(localToday().slice(5, 7))

    function emitChange() {
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
    }

    function setValue(value, notify) {
      input.value = value || ''
      draftValue = input.value
      wrapper.classList.remove('invalid')
      trigger.removeAttribute('aria-invalid')
      const selected = parts(input.value)
      if (selected) {
        viewYear = selected.year
        viewMonth = selected.month
      }
      trigger.textContent = formatDate(input.value) || 'Choose date'
      trigger.setAttribute('aria-label', input.value ? `Flight date: ${formatDate(input.value)}` : 'Choose flight date')
      if (notify) emitChange()
      if (visible) render()
    }

    function changeMonth(delta) {
      const index = Math.min(9999 * 12 + 11, Math.max(1000 * 12, viewYear * 12 + viewMonth - 1 + delta))
      const next = new Date(Date.UTC(Math.floor(index / 12), index % 12, 1))
      viewYear = next.getUTCFullYear()
      viewMonth = next.getUTCMonth() + 1
      const draft = parts(draftValue)
      if (draft) draftValue = dateString(viewYear, viewMonth, draft.day)
      render()
    }

    function close(restoreFocus) {
      visible = false
      calendar.hidden = true
      wrapper.classList.remove('open')
      trigger.setAttribute('aria-expanded', 'false')
      if (restoreFocus) trigger.focus()
    }

    function commitDraft() {
      if (!draftValue) return
      setValue(draftValue, true)
      close(true)
    }

    function applyYear(field) {
      const year = Number(field.value)
      if (year < 1000 || year > 9999 || !Number.isInteger(year)) {
        field.value = String(viewYear)
        return false
      }
      viewYear = year
      const updated = draftValue ? core.dateInYear(draftValue, year) : ''
      if (updated) draftValue = updated
      render()
      calendar.querySelector('.flight-date-year')?.focus()
      return true
    }

    function render() {
      const selected = parts(draftValue)
      const months = Array.from({ length: 12 }, (_, index) => {
        const value = index + 1
        const label = monthFormatter.format(new Date(Date.UTC(2020, index, 1)))
        return `<option value="${value}"${value === viewMonth ? ' selected' : ''}>${label}</option>`
      }).join('')

      const offset = (new Date(Date.UTC(viewYear, viewMonth - 1, 1)).getUTCDay() - firstWeekday() + 7) % 7
      const gridStart = new Date(Date.UTC(viewYear, viewMonth - 1, 1 - offset))
      const weekdays = Array.from({ length: 7 }, (_, index) => {
        const day = (firstWeekday() + index) % 7
        const date = new Date(Date.UTC(2023, 0, 1 + day))
        return `<span class="flight-date-weekday">${weekdayFormatter.format(date)}</span>`
      }).join('')
      let days = ''
      for (let index = 0; index < 42; index += 1) {
        const date = new Date(gridStart.getTime() + index * 86400000)
        const value = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`
        const inMonth = date.getUTCMonth() + 1 === viewMonth
        const isSelected = selected && value === draftValue
        const outOfRange = date.getUTCFullYear() < 1000 || date.getUTCFullYear() > 9999
        days += `<button type="button" class="flight-date-day${inMonth ? '' : ' outside'}${isSelected ? ' selected' : ''}" data-date="${value}" aria-label="${fullDateFormatter.format(date)}" aria-pressed="${!!isSelected}"${outOfRange ? ' disabled' : ''}>${date.getUTCDate()}</button>`
      }

      calendar.innerHTML = `
        <div class="flight-date-heading">
          <button type="button" class="flight-date-nav" data-month-step="-1" aria-label="Previous month">‹</button>
          <select class="flight-date-month" aria-label="Month">${months}</select>
          <input class="flight-date-year" type="number" min="1000" max="9999" step="1" inputmode="numeric" aria-label="Year" value="${viewYear}">
          <button type="button" class="flight-date-nav" data-month-step="1" aria-label="Next month">›</button>
        </div>
        <div class="flight-date-weekdays">${weekdays}</div>
        <div class="flight-date-days">${days}</div>
        <div class="flight-date-footer"><button type="button" class="flight-date-enter"${draftValue ? '' : ' disabled'}>Enter</button></div>`
    }

    trigger.addEventListener('click', () => {
      visible = !visible
      if (!visible) { close(false); return }
      const selected = parts(input.value)
      draftValue = input.value || ''
      if (selected) { viewYear = selected.year; viewMonth = selected.month }
      else {
        const today = parts(localToday())
        viewYear = today.year
        viewMonth = today.month
      }
      render()
      calendar.hidden = false
      wrapper.classList.add('open')
      trigger.setAttribute('aria-expanded', 'true')
    })

    calendar.addEventListener('click', event => {
      const step = event.target.closest('[data-month-step]')
      if (step) {
        changeMonth(Number(step.dataset.monthStep))
        calendar.querySelector(`[data-month-step="${step.dataset.monthStep}"]`)?.focus()
        return
      }
      const day = event.target.closest('[data-date]')
      if (day) {
        draftValue = day.dataset.date
        render()
        calendar.querySelector(`[data-date="${draftValue}"]`)?.focus()
        return
      }
      if (event.target.closest('.flight-date-enter')) commitDraft()
    })

    calendar.addEventListener('change', event => {
      if (event.target.matches('.flight-date-month')) {
        viewMonth = Number(event.target.value)
        const draft = parts(draftValue)
        if (draft) draftValue = dateString(viewYear, viewMonth, draft.day)
        render()
        calendar.querySelector('.flight-date-month')?.focus()
      } else if (event.target.matches('.flight-date-year')) {
        applyYear(event.target)
      }
    })

    document.addEventListener('pointerdown', event => {
      if (visible && !wrapper.contains(event.target)) close(false)
    })
    wrapper.addEventListener('keydown', event => {
      if (event.key === 'Escape' && visible) {
        event.preventDefault()
        close(true)
      } else if (event.key === 'Enter' && visible) {
        event.preventDefault()
        const year = event.target.closest('.flight-date-year')
        if (year && !applyYear(year)) return
        const day = event.target.closest('.flight-date-day')
        if (day) draftValue = day.dataset.date
        commitDraft()
      }
    })
    input.form?.addEventListener('reset', () => setTimeout(() => setValue('', false), 0))

    setValue(input.value, false)
    return {
      input,
      set: value => setValue(value, false),
      get: () => input.value,
      focus: () => trigger.focus(),
      setInvalid: invalid => {
        wrapper.classList.toggle('invalid', !!invalid)
        trigger.setAttribute('aria-invalid', invalid ? 'true' : 'false')
      },
      refresh: () => setValue(input.value, false),
    }
  }

  root.FlightDatePicker = { mount }
})(typeof window !== 'undefined' ? window : globalThis)
